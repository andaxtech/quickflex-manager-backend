const axios = require('axios');
const OpenAI = require('openai');
const config = require('./intelligenceConfig');

class StoreIntelligenceService {
  constructor(openAIKey, googleMapsKey, weatherService, dbPool) {
    this.openai = new OpenAI({ apiKey: openAIKey });
    this.googleMapsKey = googleMapsKey;
    this.weatherService = weatherService;
    this.dbPool = dbPool;
    this.cache = new Map();
    this.config = config;
    this.lastApiCall = 0;
    this.minApiDelay = 100;
    this.lastTicketmasterCall = 0; // Add this line
  }

  async generateStoreInsight(store) {
    try {
      // Normalize store data
      const normalizedStore = this.normalizeStore(store);
      
      // Validate required fields
      if (!this.validateStore(normalizedStore)) {
        return this.getFallbackInsight(normalizedStore);
      }

      // Collect external data in parallel
      const externalData = await this.collectExternalData(normalizedStore);
      
      // Get store context
      const storeContext = await this.getStoreContext(normalizedStore);
      
      // Generate AI insight with clean, focused data
      return await this.generateAIInsight(normalizedStore, externalData, storeContext);
      
    } catch (error) {
      console.error('Error generating store insight:', error);
      return this.getFallbackInsight(store);
    }
  }

  normalizeStore(store) {
    return {
      id: store.store_id || store.id,
      city: store.city,
      state: store.state || store.region,
      lat: parseFloat(store.store_latitude),
      lng: parseFloat(store.store_longitude),
      timezone: store.time_zone_code,
      isOnline: store.is_online_now && !store.is_force_offline,
      cashLimit: store.cash_limit,
      deliveryFee: store.delivery_fee,
      waitTime: store.estimated_wait_minutes || 25,
      minOrder: store.minimum_delivery_order_amount || 15,
      openShifts: store.shifts?.open || 0,
      bookedShifts: store.shifts?.booked || 0
    };
  }

  validateStore(store) {
    return store.id && store.city && store.state && 
           !isNaN(store.lat) && !isNaN(store.lng);
  }

  async collectExternalData(store) {
    const [weather, traffic, events] = await Promise.allSettled([
      this.getWeatherData(store),
      this.getTrafficData(store),
      this.getEventData(store)
    ]);

    return {
      weather: weather.status === 'fulfilled' ? weather.value : null,
      traffic: traffic.status === 'fulfilled' ? traffic.value : null,
      events: events.status === 'fulfilled' ? events.value : []
    };
  }

  async getWeatherData(store) {
    try {
      const weather = await this.weatherService.getWeatherByCity(
        store.city, 
        store.state, 
        store
      );
      
      if (!weather) return null;
      
      return {
        temp: Math.round(weather.temperature),
        condition: weather.condition,
        isRaining: weather.condition.toLowerCase().includes('rain'),
        isSevere: weather.condition.toLowerCase().match(/storm|snow|blizzard/)
      };
    } catch (error) {
      console.error('Weather fetch error:', error);
      return null;
    }
  }

  async getTrafficData(store) {
    const cacheKey = `traffic_${store.id}`;
    const cached = this.getCached(cacheKey, 600000); // 10 min cache
    if (cached) return cached;

    try {
      // Get traffic for a 3km radius check
      const response = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
        params: {
          origin: `${store.lat},${store.lng}`,
          destination: `${store.lat + 0.027},${store.lng + 0.027}`, // ~3km
          mode: 'driving',
          departure_time: 'now',
          traffic_model: 'best_guess',
          key: this.googleMapsKey
        }
      });

      if (!response.data.routes?.[0]) return null;

      const route = response.data.routes[0].legs[0];
      const normalTime = route.duration.value;
      const currentTime = route.duration_in_traffic?.value || normalTime;
      const delayMinutes = Math.round((currentTime - normalTime) / 60);

      const trafficData = {
        delayMinutes,
        severity: this.getTrafficSeverity(delayMinutes),
        affectsDelivery: delayMinutes > 10
      };

      this.setCache(cacheKey, trafficData);
      return trafficData;
      
    } catch (error) {
      console.error('Traffic API error:', error);
      return null;
    }
  }

  getTrafficSeverity(delayMinutes) {
    if (delayMinutes > 20) return 'severe';
    if (delayMinutes > 10) return 'moderate';
    return 'light';
  }

  async getEventData(store) {
    const cacheKey = `events_${store.id}`;
    const cached = this.getCached(cacheKey, 3600000); // 1 hour cache
    if (cached) return cached;
  
    try {
      const tmApiKey = process.env.TICKETMASTER_API_KEY;
      if (!tmApiKey) return [];
  
      // Rate limit protection for Ticketmaster API
      const now = Date.now();
      if (this.lastTicketmasterCall && (now - this.lastTicketmasterCall) < 1000) {
        await new Promise(resolve => setTimeout(resolve, 1000 - (now - this.lastTicketmasterCall)));
      }
      this.lastTicketmasterCall = Date.now();
  
      const response = await axios.get('https://app.ticketmaster.com/discovery/v2/events.json', {
        params: {
          apikey: tmApiKey,
          latlong: `${store.lat},${store.lng}`,
          radius: '5',
          unit: 'miles',
          size: 10,
          sort: 'date,asc'
        },
        timeout: 5000 // 5 second timeout
      });

      if (!response.data._embedded?.events) return [];

      const events = response.data._embedded.events
        .map(this.processEvent)
        .filter(event => event.impact >= 0.5)
        .slice(0, 3);

      this.setCache(cacheKey, events);
      return events;
      
    } catch (error) {
      if (error.response?.status === 429) {
        console.log('Ticketmaster rate limit hit - returning empty events');
        // Cache empty result for 5 minutes to avoid hitting rate limit
        this.setCache(cacheKey, [], 300000);
      } else {
        console.error('Events API error:', error.message);
      }
      return [];
    }
  }

  processEvent(event) {
    const venue = event._embedded?.venues?.[0];
    const capacity = parseInt(venue?.capacity) || 5000;
    const eventDate = new Date(event.dates.start.dateTime);
    
    return {
      name: event.name,
      venue: venue?.name || 'Unknown',
      date: eventDate,
      time: eventDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      capacity,
      type: event.classifications?.[0]?.segment?.name || 'Event',
      impact: this.calculateEventImpact(capacity, eventDate)
    };
  }

  calculateEventImpact(capacity, eventDate) {
    let impact = 0;
    
    // Capacity impact
    if (capacity > 20000) impact += 0.6;
    else if (capacity > 10000) impact += 0.4;
    else if (capacity > 5000) impact += 0.2;
    
    // Timing impact
    const hour = eventDate.getHours();
    if (hour >= 18 && hour <= 22) impact += 0.3; // Prime dinner time
    
    // Weekend impact
    const day = eventDate.getDay();
    if (day === 5 || day === 6) impact += 0.1;
    
    return Math.min(impact, 1);
  }

  async getStoreContext(store) {
    // Get store classification
    const storeType = await this.classifyStore(store);
    
    // Get current time in store's timezone
    const localTime = this.getStoreLocalTime(store);
    
    return {
      type: storeType.type,
      localTime,
      hour: localTime.getHours(),
      dayOfWeek: localTime.getDay(),
      isWeekend: localTime.getDay() === 0 || localTime.getDay() === 6,
      isPeakTime: localTime.getHours() >= 17 && localTime.getHours() <= 20,
      isLateNight: localTime.getHours() >= 21 || localTime.getHours() < 2
    };
  }

  async classifyStore(store) {
    // Check database for saved classification
    const saved = await this.getSavedClassification(store.id);
    if (saved) return saved;
    
    // Auto-classify based on location
    const classification = await this.autoClassifyStore(store);
    await this.saveClassification(store.id, classification);
    
    return classification;
  }

  async getSavedClassification(storeId) {
    try {
      const result = await this.dbPool.query(
        'SELECT metadata FROM locations WHERE store_id = $1',
        [storeId]
      );
      
      if (result.rows[0]?.metadata?.store_type) {
        return {
          type: result.rows[0].metadata.store_type,
          subType: result.rows[0].metadata.sub_type
        };
      }
    } catch (error) {
      console.error('Error getting classification:', error);
    }
    return null;
  }

  async autoClassifyStore(store) {
    // Simplified classification logic
    const militaryBases = this.config.locations.militaryBases[store.state] || [];
    const colleges = this.config.locations.colleges[store.state] || [];
    
    if (this.isNearLocation(store, militaryBases)) {
      return { type: 'military', subType: 'base' };
    }
    
    if (this.isNearLocation(store, colleges)) {
      return { type: 'college', subType: 'campus' };
    }
    
    return { type: 'suburban', subType: 'standard' };
  }

  isNearLocation(store, locations) {
    return locations.some(loc => 
      this.calculateDistance(store.lat, store.lng, loc.lat, loc.lng) <= loc.radius
    );
  }

  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 3959; // Earth radius in miles
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }

  async saveClassification(storeId, classification) {
    try {
      await this.dbPool.query(
        `UPDATE locations 
         SET metadata = COALESCE(metadata::jsonb, '{}'::jsonb) || $2::jsonb
         WHERE store_id = $1`,
        [storeId, JSON.stringify({
          store_type: classification.type,
          sub_type: classification.subType,
          classified_at: new Date().toISOString()
        })]
      );
    } catch (error) {
      console.error('Error saving classification:', error);
    }
  }

  getStoreLocalTime(store) {
    const now = new Date();
    const offset = this.parseTimezoneOffset(store.timezone);
    
    // Create a new date adjusted for timezone
    const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
    const storeTime = new Date(utcTime + (offset * 60000));
    
    return storeTime;
  }

  parseTimezoneOffset(timezone) {
    if (!timezone) return -480; // Default PST
    
    const match = timezone.match(/GMT([+-])(\d{2}):(\d{2})/);
    if (!match) return -480;
    
    const sign = match[1] === '+' ? 1 : -1;
    const hours = parseInt(match[2], 10);
    const minutes = parseInt(match[3], 10);
    
    return sign * (hours * 60 + minutes);
  }

  async generateAIInsight(store, data, context) {
    const prompt = this.buildCleanPrompt(store, data, context);
    
    try {
      // Rate limiting
      await this.enforceRateLimit();
      
      const completion = await this.openai.chat.completions.create({
        model: this.config.ai.model || 'gpt-4',
        messages: [
          {
            role: "system",
            content: this.getSystemPrompt()
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.7,
        max_tokens: 500,
        response_format: { type: "json_object" }
      });

      const response = JSON.parse(completion.choices[0].message.content);
      return this.validateResponse(response);
      
    } catch (error) {
      console.error('AI generation error:', error);
      return this.getFallbackInsight(store);
    }
  }

  buildCleanPrompt(store, data, context) {
    const factors = this.identifyKeyFactors(data, context);
    const timeStr = context.localTime.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit' 
    });
    
    const prompt = [
      `Store #${store.id} in ${store.city}, ${store.state}`,
      `Current time: ${timeStr}`,
      `Store type: ${context.type}`,
      `Staff available: ${store.openShifts} open shifts, ${store.bookedShifts} booked`,
      '',
      'CURRENT CONDITIONS:'
    ];

    // Add only relevant data
    if (data.weather) {
      prompt.push(`- Weather: ${data.weather.temp}°F, ${data.weather.condition}`);
    }
    
    if (data.traffic?.affectsDelivery) {
      prompt.push(`- Traffic: ${data.traffic.delayMinutes} min delays (${data.traffic.severity})`);
    }
    
    if (data.events.length > 0) {
      const eventSummary = data.events
        .map(e => `${e.name} at ${e.time}`)
        .join(', ');
      prompt.push(`- Events: ${eventSummary}`);
    }
    
    if (factors.length > 0) {
      prompt.push('', 'KEY FACTORS:', ...factors.map(f => `- ${f}`));
    }

    prompt.push(
      '',
      'Generate a JSON response with:',
      '- insight: One specific, actionable recommendation (max 100 chars)',
      '- severity: "info", "warning", or "critical"',
      '- metrics: {',
      '    expectedOrderIncrease: 0-100 percentage',
      '    recommendedExtraDrivers: 0-10',
      '    primaryReason: main factor driving this recommendation',
      '  }',
      '- action: What to do RIGHT NOW (max 80 chars)'
    );
    
    return prompt.join('\n');
  }

  identifyKeyFactors(data, context) {
    const factors = [];
    
    // Weather impact
    if (data.weather?.isRaining) {
      factors.push('Rain typically increases delivery orders by 30-40%');
    }
    
    if (data.weather?.isSevere) {
      factors.push('Severe weather warning - expect significant order surge');
    }
    
    // Traffic impact
    if (data.traffic?.severity === 'severe') {
      factors.push('Heavy traffic will extend delivery times');
    }
    
    // Event impact
    if (data.events.length > 0) {
      const totalCapacity = data.events.reduce((sum, e) => sum + e.capacity, 0);
      if (totalCapacity > 20000) {
        factors.push(`Major events with ${totalCapacity.toLocaleString()} attendees nearby`);
      }
    }
    
    // Time-based patterns
    if (context.isWeekend && context.isPeakTime) {
      factors.push('Weekend dinner rush - typically 25% busier');
    }
    
    if (context.type === 'military' && [1, 15].includes(new Date().getDate())) {
      factors.push('Military payday - expect 40% increase');
    }
    
    return factors;
  }

  getSystemPrompt() {
    return `You are an AI assistant for Domino's Pizza store managers. 
Your role is to provide clear, actionable insights based on current conditions.

Guidelines:
- Be specific and practical
- Focus on immediate actions the manager can take
- Use encouraging, supportive language
- Keep recommendations realistic
- Base all insights on the provided data only
- Respond with valid JSON only`;
  }

  validateResponse(response) {
    return {
      insight: String(response.insight || "Monitor operations closely").substring(0, 100),
      severity: ["info", "warning", "critical"].includes(response.severity) 
        ? response.severity : "info",
      metrics: {
        expectedOrderIncrease: Math.min(100, Math.max(0, 
          Number(response.metrics?.expectedOrderIncrease) || 0)),
        recommendedExtraDrivers: Math.min(10, Math.max(0, 
          Math.floor(Number(response.metrics?.recommendedExtraDrivers) || 0))),
        primaryReason: String(response.metrics?.primaryReason || "standard operations")
      },
      action: String(response.action || "Maintain current staffing").substring(0, 80)
    };
  }

  async enforceRateLimit() {
    const now = Date.now();
    const timeSinceLastCall = now - this.lastApiCall;
    
    if (timeSinceLastCall < this.minApiDelay) {
      await new Promise(resolve => 
        setTimeout(resolve, this.minApiDelay - timeSinceLastCall)
      );
    }
    
    this.lastApiCall = Date.now();
  }

  getFallbackInsight(store) {
    return {
      insight: "Stay ready for standard operations today",
      severity: "info",
      metrics: {
        expectedOrderIncrease: 0,
        recommendedExtraDrivers: 0,
        peakHours: null,
        primaryReason: "normal conditions"
      },
      action: "Monitor orders and adjust as needed",
      todayActions: "Follow standard operating procedures",
      weekOutlook: "Normal patterns expected this week"
    };
  }

  getCached(key, defaultTtl) {
    const cached = this.cache.get(key);
    if (!cached) return null;
    
    const ttl = cached.ttl || defaultTtl;
    if (Date.now() - cached.timestamp > ttl) {
      this.cache.delete(key);
      return null;
    }
    
    return cached.data;
  }
  
  setCache(key, data, customTtl = null) {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl: customTtl
    });
  }

  // Batch processing with better error handling
  async generateBatchInsights(stores, batchSize = 5) {
    const results = [];
    
    for (let i = 0; i < stores.length; i += batchSize) {
      const batch = stores.slice(i, i + batchSize);
      
      const batchResults = await Promise.allSettled(
        batch.map(store => this.generateStoreInsight(store))
      );
      
      results.push(...batchResults.map((result, index) => 
        result.status === 'fulfilled' 
          ? result.value 
          : this.getFallbackInsight(batch[index])
      ));
      
      // Delay between batches
      if (i + batchSize < stores.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    return results;
  }
}

module.exports = StoreIntelligenceService;