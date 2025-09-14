// Add this at the very top of your file to help debug
console.log('Loading StoreIntelligenceService...');

const axios = require('axios');
const OpenAI = require('openai');
const config = require('./intelligenceConfig');

class StoreIntelligenceService {
  constructor(openAIKey, googleMapsKey, weatherService, dbPool) {
    console.log('Initializing StoreIntelligenceService...');
    this.openai = new OpenAI({ apiKey: openAIKey });
    this.googleMapsKey = googleMapsKey;
    this.weatherService = weatherService;
    this.dbPool = dbPool;
    this.cache = new Map();
    this.config = config;
  }

  // Main method to generate insights
  async generateStoreInsight(store) {
    try {
      // Ensure we have coordinates
      if (!store.store_latitude || !store.store_longitude) {
        console.warn(`Store ${store.store_id} missing coordinates`);
        return this.getFallbackInsight(store);
      }

      // Collect all data in parallel
      const [weather, traffic, holidays, events] = await Promise.allSettled([
        this.weatherService.getWeatherByCity(store.city, store.region || store.state, store),
        this.getTrafficData(store),
        this.getHolidays(),
        this.getLocalEvents(store)
      ]);

      // Build the data object with store-specific data
      const collectedData = {
        weather: weather.status === 'fulfilled' ? weather.value : null,
        traffic: traffic.status === 'fulfilled' ? traffic.value : null,
        holidays: holidays.status === 'fulfilled' ? holidays.value : null,
        events: events.status === 'fulfilled' ? events.value : null,
        storeType: await this.classifyStore(store),
        storeStatus: {
          isOnline: store.is_online_now && !store.is_force_offline,
          cashLimit: store.cash_limit,
          deliveryFee: store.delivery_fee,
          spanishEnabled: store.is_spanish,
          waitTime: store.estimated_wait_minutes
        }
      };

      // Generate AI insight
      return await this.generateAIInsight(store, collectedData);
    } catch (error) {
      console.error('Error generating store insight:', error);
      return this.getFallbackInsight(store);
    }
  }

  async classifyStore(store) {
    // First, check if store has classification in database
    const dbClassification = await this.getStoreClassification(store.store_id);
    if (dbClassification) return dbClassification;

    // Otherwise, use proximity detection
    const militaryBases = this.config.locations.militaryBases[store.state] || [];
    const colleges = this.config.locations.colleges[store.state] || [];

    // Check proximity to military bases
    const nearbyBase = this.findNearbyLocation(store, militaryBases);
    
    if (nearbyBase) {
      return {
        type: 'military',
        subType: nearbyBase.name,
        patterns: await this.getPatternsByType('military')
      };
    }

    // Check proximity to colleges
    const nearbyCollege = this.findNearbyLocation(store, colleges);
    
    if (nearbyCollege) {
      return {
        type: 'college',
        subType: nearbyCollege.name,
        patterns: await this.getPatternsByType('college')
      };
    }

    // Default classification
    return {
      type: 'suburban',
      subType: 'standard',
      patterns: await this.getPatternsByType('suburban')
    };
  }

  async getStoreClassification(storeId) {
    try {
      const result = await this.dbPool.query(
        'SELECT store_type, sub_type FROM store_classifications WHERE store_id = $1',
        [storeId]
      );
      
      if (result.rows.length > 0) {
        const row = result.rows[0];
        return {
          type: row.store_type,
          subType: row.sub_type,
          patterns: await this.getPatternsByType(row.store_type)
        };
      }
    } catch (error) {
      console.error('Error fetching store classification:', error);
    }
    return null;
  }

  async getPatternsByType(type) {
    // These should also come from database eventually
    const patterns = {
      military: {
        paydaySurge: { dates: [1, 15], multiplier: 1.45 },
        weeklyPattern: { friday: 1.4, saturday: 1.5 }
      },
      college: {
        weeklyPattern: { thursday: 1.3, friday: 1.4, saturday: 1.5 },
        lateNightMultiplier: 1.5
      },
      suburban: {
        weeklyPattern: { friday: 1.2, saturday: 1.3 },
        familyDinnerHours: '17-19'
      }
    };
    
    return patterns[type] || patterns.suburban;
  }

  async getTrafficData(store) {
    const cacheKey = `traffic_${store.store_id}`;
    const cached = this.getCached(cacheKey, this.config.cache.traffic);
    if (cached) return cached;

    try {
      // Calculate destination based on configured distance
      const kmToDegrees = this.config.traffic.sampleDistanceKm / 111; // rough conversion
      
      const url = 'https://maps.googleapis.com/maps/api/directions/json';
const response = await axios.get(url, {
  params: {
            origin: `${store.store_latitude},${store.store_longitude}`,
            destination: `${store.store_latitude + kmToDegrees},${store.store_longitude + kmToDegrees}`,
            mode: 'driving',
            departure_time: 'now',
            traffic_model: 'best_guess',
            key: this.googleMapsKey
          }
        }
      );

      const route = response.data.routes[0];
      if (!route) return null;

      const normalDuration = route.legs[0].duration.value;
      const trafficDuration = route.legs[0].duration_in_traffic?.value || normalDuration;
      const delayMinutes = Math.round((trafficDuration - normalDuration) / 60);

      const result = {
        delayMinutes,
        congestionLevel: this.calculateCongestionLevel(delayMinutes)
      };

      this.setCache(cacheKey, result);
      return result;
    } catch (error) {
      console.error('Traffic API error:', error);
      return null;
    }
  }

  calculateCongestionLevel(delayMinutes) {
    const { heavy, moderate } = this.config.traffic.congestionThresholds;
    
    if (delayMinutes > heavy) return 'heavy';
    if (delayMinutes > moderate) return 'moderate';
    return 'light';
  }

  // analyze holidays
  async getHolidays() {
    const cacheKey = 'holidays_US';
    const cached = this.getCached(cacheKey, this.config.cache.holidays);
    if (cached) return cached;

    try {
      const year = new Date().getFullYear();
      const response = await axios.get(
        `https://date.nager.at/api/v3/PublicHolidays/${year}/US`
      );

      const holidays = response.data
        .filter(h => new Date(h.date) >= new Date())
        .slice(0, 10);

      this.setCache(cacheKey, holidays);
      return holidays;
    } catch (error) {
      console.error('Holiday API error:', error);
      return [];
    }
  }

  // analyze local events
  async getLocalEvents(store) {
    const cacheKey = `events_${store.store_id}`;
    const cached = this.getCached(cacheKey, this.config.cache.events || 3600000); // 1 hour cache
    if (cached) return cached;

    try {
      // Ticketmaster requires API key
      const tmApiKey = process.env.TICKETMASTER_API_KEY;
      if (!tmApiKey) {
        console.log('Ticketmaster API key not configured');
        return [];
      }

      const now = new Date();
      const endDate = new Date();
      endDate.setDate(endDate.getDate() + 7); // Next 7 days

      const response = await axios.get(
        'https://app.ticketmaster.com/discovery/v2/events.json',
        {
          params: {
            apikey: tmApiKey,
            latlong: `${store.store_latitude},${store.store_longitude}`,
            radius: '15', // 15 miles
            unit: 'miles',
            startDateTime: now.toISOString().split('.')[0] + 'Z',
            endDateTime: endDate.toISOString().split('.')[0] + 'Z',
            size: 20,
            sort: 'date,asc',
            classificationName: 'Sports,Music,Arts & Theatre' // High-impact events
          }
        }
      );

      if (!response.data._embedded?.events) {
        this.setCache(cacheKey, []);
        return [];
      }

      // Process and filter events
      const events = response.data._embedded.events
        .map(event => ({
          name: event.name,
          date: event.dates.start.localDate,
          time: event.dates.start.localTime,
          venue: event._embedded?.venues?.[0]?.name || 'Unknown venue',
          capacity: event._embedded?.venues?.[0]?.boxOfficeInfo?.generalInfo || null,
          distance: event._embedded?.venues?.[0]?.distance || null,
          type: event.classifications?.[0]?.segment?.name || 'Event',
          impact: this.calculateEventImpact(event)
        }))
        .filter(event => event.impact > 0.3) // Only high-impact events
        .slice(0, 5); // Top 5 events

      this.setCache(cacheKey, events);
      return events;
    } catch (error) {
      console.error('Ticketmaster API error:', error.response?.data || error.message);
      return [];
    }
  }

  calculateEventImpact(event) {
    let impact = 0;
    
    // Venue size impact
    const venue = event._embedded?.venues?.[0];
    if (venue) {
      const capacity = parseInt(venue.capacity) || 0;
      if (capacity > 50000) impact += 0.5;
      else if (capacity > 20000) impact += 0.4;
      else if (capacity > 10000) impact += 0.3;
      else if (capacity > 5000) impact += 0.2;
      
      // Distance impact (closer = higher impact)
      const distance = parseFloat(venue.distance) || 15;
      if (distance < 3) impact += 0.3;
      else if (distance < 5) impact += 0.2;
      else if (distance < 10) impact += 0.1;
    }
    
    // Event type impact
    const eventType = event.classifications?.[0]?.segment?.name;
    if (eventType === 'Sports') impact += 0.2;
    if (eventType === 'Music') impact += 0.15;
    
    // Day of week impact
    const eventDate = new Date(event.dates.start.localDate);
    const dayOfWeek = eventDate.getDay();
    if (dayOfWeek === 5 || dayOfWeek === 6) impact += 0.1; // Friday/Saturday
    
    return Math.min(impact, 1); // Cap at 1
  }

  async generateAIInsight(store, data) {
    const prompt = this.buildIntelligencePrompt(store, data);
    
    try {
      const completion = await this.openai.chat.completions.create({
        model: this.config.ai.model,
        messages: [{ role: "user", content: prompt }],
        temperature: this.config.ai.temperature,
        max_tokens: this.config.ai.maxTokens,
        response_format: { type: "json_object" }
      });

      return JSON.parse(completion.choices[0].message.content);
    } catch (error) {
      console.error('OpenAI API error:', error);
      return this.getFallbackInsight(store);
    }
  }

  async buildIntelligencePrompt(store, data) {
    const now = new Date();
    const localTime = this.getStoreLocalTime(store);
    const baselines = await this.getStoreBaselines(store.store_id);
    
    // Format events for prompt
    const eventsSummary = data.events && data.events.length > 0
      ? data.events.map(e => `${e.date}: ${e.name} at ${e.venue} (${e.type})`).join('; ')
      : 'No major events';
    
    return `You are Domino's Store Mentor. Generate ONE actionable insight for store ${store.store_id}.

    Store Context:
    - Location: ${store.city}, ${store.region || store.state}
    - Type: ${data.storeType.type}
    - Local Time: ${localTime}
    - Open Shifts: ${store.shifts?.open || 0}
    - Booked Shifts: ${store.shifts?.booked || 0}
    
    Current Data:
    - Weather: ${data.weather ? data.weather.temperature + '°F, ' + data.weather.condition : 'unavailable'}
    - Traffic: ${data.traffic ? data.traffic.delayMinutes + ' min delays' : 'normal'}
    - Holidays (next 7 days): ${data.holidays?.slice(0,3).map(h => h.name).join(', ') || 'none'}
    - Local Events: ${eventsSummary}
    
    ${data.events && data.events.length > 0 ? 'EVENT IMPACT: Major events detected nearby that will drive pizza demand.' : ''}
    
    Baselines:
    - Delivery: ${baselines.delivery.min}-${baselines.delivery.max} minutes
    - Carryout: ${baselines.carryout.min}-${baselines.carryout.max} minutes
    - Min delivery: $${baselines.minOrder}
    
    Return JSON with:
    {
      "insight": "specific action for NOW (max 100 chars)",
      "severity": "info|warning|critical",
      "metrics": {
        "expectedOrderIncrease": percentage,
        "recommendedExtraDrivers": number,
        "peakHours": "17-20" or null
      },
      "todayActions": "what to do TODAY (max 80 chars)",
      "weekOutlook": "5-day forecast impact (max 80 chars)"
    }`;
  }

  async getStoreBaselines(storeId) {
    // Try to get from database first
    try {
      const result = await this.dbPool.query(
        `SELECT 
          delivery_min_minutes, 
          delivery_max_minutes,
          carryout_min_minutes,
          carryout_max_minutes,
          minimum_delivery_order_amount
        FROM store_baselines 
        WHERE store_id = $1`,
        [storeId]
      );

      if (result.rows.length > 0) {
        const row = result.rows[0];
        return {
          delivery: { 
            min: row.delivery_min_minutes, 
            max: row.delivery_max_minutes 
          },
          carryout: { 
            min: row.carryout_min_minutes, 
            max: row.carryout_max_minutes 
          },
          minOrder: row.minimum_delivery_order_amount
        };
      }
    } catch (error) {
      console.error('Error fetching store baselines:', error);
    }

    // Return defaults from config
    return {
      delivery: this.config.baselines.deliveryMinutes,
      carryout: this.config.baselines.carryoutMinutes,
      minOrder: this.config.baselines.minDeliveryOrder
    };
  }

  getStoreLocalTime(store) {
    const now = new Date();
    const offset = this.getStoreOffset(store);
    const localTime = new Date(now.getTime() + (offset * 60000));
    return localTime.toISOString();
  }

  getStoreOffset(store) {
    if (!store.time_zone_code) return -480; // PST default
    
    const match = store.time_zone_code.match(/GMT([+-])(\d{2}):(\d{2})/);
    if (!match) return -480;
    
    const sign = match[1] === '+' ? 1 : -1;
    const hours = parseInt(match[2], 10);
    const mins = parseInt(match[3], 10);
    return sign * (hours * 60 + mins);
  }

  getFallbackInsight(store) {
    return {
      insight: "Unable to generate AI insight. Monitor standard operations.",
      severity: "info",
      metrics: {
        expectedOrderIncrease: 0,
        recommendedExtraDrivers: 0,
        peakHours: null
      },
      todayActions: "Follow standard staffing patterns",
      weekOutlook: "Check weather forecast manually"
    };
  }

  // Helper methods
  getCached(key, ttl) {
    const cached = this.cache.get(key);
    if (!cached) return null;
    
    if (Date.now() - cached.timestamp > ttl) {
      this.cache.delete(key);
      return null;
    }
    
    return cached.data;
  }
  
  setCache(key, data) {
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
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

  findNearbyLocation(store, locations) {
    if (!store.store_latitude || !store.store_longitude) return null;
    
    for (const location of locations) {
      const distance = this.calculateDistance(
        store.store_latitude,
        store.store_longitude,
        location.lat,
        location.lng
      );
      
      if (distance <= location.radius) {
        return location;
      }
    }
    return null;
  }
}

console.log('StoreIntelligenceService loaded successfully');
module.exports = StoreIntelligenceService;