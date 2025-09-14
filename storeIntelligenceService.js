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
    this.minApiDelay = 100; // milliseconds between API calls
  }

  async generateStoreInsight(store) {
    try {
      // Normalize store ID field
      store.store_id = store.store_id || store.id;
      
      // Validate required fields
      if (!store.store_id || !store.city || !store.state) {
      console.error(`Missing required fields for store: ${store.store_id || store.id}`);
      return this.getFallbackInsight(store);
    }
      if (!store.store_latitude || !store.store_longitude) {
        console.warn(`Store ${store.store_id || store.id} missing coordinates`);
        return this.getFallbackInsight(store);
      }

      const dataPromises = [
        this.weatherService.getWeatherByCity(store.city, store.region || store.state, store),
        this.getTrafficData(store),
        this.getHolidays(),
        this.getLocalEvents(store)
      ];

      const results = await Promise.allSettled(dataPromises);
      console.log(`Store ${store.store_id}: Events result:`, results[3]);


      const collectedData = {
        weather: results[0].status === 'fulfilled' ? results[0].value : null,
        traffic: results[1].status === 'fulfilled' ? results[1].value : null,
        holidays: results[2].status === 'fulfilled' ? results[2].value : null,
        events: results[3].status === 'fulfilled' ? results[3].value : null,
        storeType: await this.classifyStore(store),
        storeStatus: {
          isOnline: store.is_online_now && !store.is_force_offline,
          cashLimit: store.cash_limit,
          deliveryFee: store.delivery_fee,
          spanishEnabled: store.is_spanish,
          waitTime: store.estimated_wait_minutes
        }
      };

      return await this.generateAIInsight(store, collectedData);
    } catch (error) {
      console.error('Error generating store insight:', error);
      return this.getFallbackInsight(store);
    }
  }

  async classifyStore(store) {
    const dbClassification = await this.getStoreClassification(store.store_id || store.id);
    if (dbClassification) return dbClassification;

    const militaryBases = this.config.locations.militaryBases[store.state] || [];
    const colleges = this.config.locations.colleges[store.state] || [];

    const nearbyBase = this.findNearbyLocation(store, militaryBases);
    if (nearbyBase) {
      const classification = {
        type: 'military',
        subType: nearbyBase.name,
        patterns: await this.getPatternsByType('military')
      };
      
      // Save to database
      await this.saveStoreClassification(store.store_id || store.id, classification);
      
      return classification;
    }

    const nearbyCollege = this.findNearbyLocation(store, colleges);
    if (nearbyCollege) {
      const classification = {
        type: 'college',
        subType: nearbyCollege.name,
        patterns: await this.getPatternsByType('college')
      };
      
      // Save to database
      await this.saveStoreClassification(store.store_id || store.id, classification);
      
      return classification;
    }

    const classification = {
      type: 'suburban',
      subType: 'standard',
      patterns: await this.getPatternsByType('suburban')
    };

    // Save to database
    await this.saveStoreClassification(store.store_id || store.id, classification);

    return classification;
  }

  async getStoreClassification(storeId) {
    try {
      // Check metadata field first for override
      const result = await this.dbPool.query(
        'SELECT metadata FROM locations WHERE store_id = $1',
        [storeId]
      );
      
      if (result.rows.length > 0 && result.rows[0].metadata) {
        const metadata = result.rows[0].metadata;
        if (metadata.store_type) {
          return {
            type: metadata.store_type,
            subType: metadata.sub_type || null,
            patterns: await this.getPatternsByType(metadata.store_type)
          };
        }
      }
    } catch (error) {
      console.error('Error checking metadata:', error);
    }
    
    // Fallback to proximity detection
    return null;
  }

  async saveStoreClassification(storeId, classification) {
    try {
      const updateQuery = `
  UPDATE locations 
  SET metadata = COALESCE(metadata::jsonb, '{}'::jsonb) || $2::jsonb
  WHERE store_id = $1
`;
      
      const metadataUpdate = {
        store_type: classification.type,
        sub_type: classification.subType,
        classification_date: new Date().toISOString(),
        classification_method: 'proximity_detection'
      };
      
      await this.dbPool.query(updateQuery, [storeId, JSON.stringify(metadataUpdate)]);
      console.log(`Saved classification for store ${storeId}: ${classification.type}`);
    } catch (error) {
      console.error('Error saving store classification:', error);
    }
  }

  async getPatternsByType(type) {
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
    const cacheKey = `traffic_${store.store_id || store.id}`;
    const cached = this.getCached(cacheKey, this.config.cache.traffic);
    if (cached) return cached;

    try {
      const kmToDegrees = this.config.traffic.sampleDistanceKm / 111;
      const origin = `${store.store_latitude},${store.store_longitude}`;
      const destination = `${store.store_latitude + kmToDegrees},${store.store_longitude + kmToDegrees}`;
      
      const url = 'https://maps.googleapis.com/maps/api/directions/json';
      const params = {
        origin: origin,
        destination: destination,
        mode: 'driving',
        departure_time: 'now',
        traffic_model: 'best_guess',
        key: this.googleMapsKey
      };
      
      const response = await axios.get(url, { params });

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
    const heavy = this.config.traffic.congestionThresholds.heavy;
    const moderate = this.config.traffic.congestionThresholds.moderate;
    
    if (delayMinutes > heavy) return 'heavy';
    if (delayMinutes > moderate) return 'moderate';
    return 'light';
  }

  async getHolidays() {
    const cacheKey = 'holidays_US';
    const cached = this.getCached(cacheKey, this.config.cache.holidays);
    if (cached) return cached;

    try {
      const year = new Date().getFullYear();
      const url = `https://date.nager.at/api/v3/PublicHolidays/${year}/US`;
      const response = await axios.get(url);

      const today = new Date();
      const weekFromNow = new Date();
      weekFromNow.setDate(today.getDate() + 7);

      const holidays = response.data
        .filter(h => {
          const holidayDate = new Date(h.date);
          return holidayDate >= today && holidayDate <= weekFromNow;
        })
        .slice(0, 10);

      this.setCache(cacheKey, holidays);
      return holidays;
    } catch (error) {
      console.error('Holiday API error:', error);
      return [];
    }
  }

  async getLocalEvents(store) {
    const cacheKey = `events_${store.store_id || store.id}`;
    console.log(`Fetching events for store ${store.store_id || store.id}`);
    const cached = this.getCached(cacheKey, this.config.cache.events || 3600000);
    if (cached) return cached;

    try {
      const tmApiKey = process.env.TICKETMASTER_API_KEY;
      if (!tmApiKey) {
        console.log('Ticketmaster API key not configured');
        return [];
      }

      const now = new Date();
      const endDate = new Date();
      endDate.setDate(endDate.getDate() + 7);

      const url = 'https://app.ticketmaster.com/discovery/v2/events.json';
      const params = {
        apikey: tmApiKey,
        latlong: `${store.store_latitude},${store.store_longitude}`,
        radius: '5',
        unit: 'miles',
        startDateTime: now.toISOString().split('.')[0] + 'Z',
        endDateTime: endDate.toISOString().split('.')[0] + 'Z',
        size: 20,
        sort: 'date,asc',
        classificationName: 'Sports,Music,Arts & Theatre'
      };

      const response = await axios.get(url, { params });

      if (!response.data._embedded?.events) {
        this.setCache(cacheKey, []);
        return [];
      }

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
      .filter(event => event.impact > 0.3)
      .slice(0, 5);

    console.log(`Found ${events.length} events for store ${store.store_id || store.id}:`, events);
          name: event.name,
          date: event.dates.start.localDate,
          time: event.dates.start.localTime,
          venue: event._embedded?.venues?.[0]?.name || 'Unknown venue',
          capacity: event._embedded?.venues?.[0]?.boxOfficeInfo?.generalInfo || null,
          distance: event._embedded?.venues?.[0]?.distance || null,
          type: event.classifications?.[0]?.segment?.name || 'Event',
          impact: this.calculateEventImpact(event)
        }))
        .filter(event => event.impact > 0.3)
        .slice(0, 5);

      this.setCache(cacheKey, events);
      return events;
    } catch (error) {
      console.error('Ticketmaster API error:', error.response?.data || error.message);
      return [];
    }
  }

  calculateEventImpact(event) {
    let impact = 0;
    
    const venue = event._embedded?.venues?.[0];
    if (venue) {
      const capacity = parseInt(venue.capacity) || 0;
      if (capacity > 50000) {
        impact += 0.5;
      } else if (capacity > 20000) {
        impact += 0.4;
      } else if (capacity > 10000) {
        impact += 0.3;
      } else if (capacity > 5000) {
        impact += 0.2;
      }
      
      const distance = parseFloat(venue.distance) || 15;
      if (distance < 3) {
        impact += 0.3;
      } else if (distance < 5) {
        impact += 0.2;
      } else if (distance < 10) {
        impact += 0.1;
      }
    }
    
    const eventType = event.classifications?.[0]?.segment?.name;
    if (eventType === 'Sports') {
      impact += 0.2;
    } else if (eventType === 'Music') {
      impact += 0.15;
    }
    
    const eventDate = new Date(event.dates.start.localDate);
    const dayOfWeek = eventDate.getDay();
    if (dayOfWeek === 5 || dayOfWeek === 6) {
      impact += 0.1;
    }
    
    return Math.min(impact, 1);
  }

  async buildIntelligencePrompt(store, data) {
    const now = new Date();
    const localTime = this.getStoreLocalTime(store);
    const baselines = await this.getStoreBaselines(store);
    
    // Parse local time more clearly
    const localDate = new Date(localTime);
    const localHour = localDate.getHours();
    const isEvening = localHour >= 18;
    const isLateEvening = localHour >= 20;
    
    // Process events more cleanly
    const eventContext = this.processEventsForPrompt(data.events);

    // Analyze multiple factors for insights
const insightFactors = this.analyzeMultipleFactors(data, localHour, localDate);
    
    // Build a focused, clear prompt
    const prompt = [
      `Generate ONE actionable insight for Domino's store ${store.store_id || store.id}.`,
      ``,
      `CURRENT SITUATION:`,
      `- Location: ${store.city}, ${store.region || store.state}`,
      `- Store Type: ${data.storeType.type}`,
      `- Local Time: ${localDate.toLocaleTimeString()} on ${localDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`,
      `- Staffing: ${store.shifts?.open || 0} open shifts, ${store.shifts?.booked || 0} booked`,
      ``,
      `CURRENT CONDITIONS:`
    ];
  

    // Add multi-factor insights
    const factors = insightFactors;
    if (factors.length > 0) {
      prompt.push(``,
        `COMPOUND FACTORS DETECTED:`,
        ...factors.map(f => `- ${f}`),
        ``
      );
    }


    // Add weather if available
    if (data.weather) {
      prompt.push(`- Weather: ${data.weather.temperature}°F, ${data.weather.condition}`);
    }
  
    // Add traffic if significant
    if (data.traffic && data.traffic.delayMinutes > 5) {
      prompt.push(`- Traffic: ${data.traffic.delayMinutes} minute delays (${data.traffic.congestionLevel} congestion)`);
    }
  
    // Add holidays
    if (data.holidays && data.holidays.length > 0) {
      const holidayNames = data.holidays.slice(0, 3).map(h => h.name).join(', ');
      prompt.push(`- Upcoming Holidays: ${holidayNames}`);
    }
  
    // Add events with enhanced details
if (eventContext.hasEvents) {
  const enhancedEvents = this.enhanceEventDetails(data.events);
  const eventDetails = enhancedEvents.map(e => 
    `${e.fullDescription} starting ${e.startTime}, ending ~${e.estimatedEndTime} (${e.crowdImpact})`
  ).join('; ');
  prompt.push(`- Local Events: ${eventDetails}`);
}
  
    prompt.push(
      ``,
      `STORE BASELINES:`,
      `- Normal Delivery: ${baselines.delivery.min}-${baselines.delivery.max} minutes`,
      `- Normal Carryout: ${baselines.carryout.min}-${baselines.carryout.max} minutes`,
      `- Minimum Delivery: $${baselines.minOrder}`,
      ``
    );
  
    // Time-based action rules (simplified)
if (isLateEvening) {
  prompt.push(
    `TIME CONSTRAINT: It's late evening (after 8 PM) - ${localDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}.`,
    `- Focus on: managing current staff, extending shifts, quality control`,
    `- Can only suggest: reallocating existing staff, calling in on-call drivers`,
    `- CANNOT suggest: booking new shifts, promotions, prep for tomorrow`,
    `- Remaining hours: Store likely closes at 11 PM or midnight`,
    ``
  );
    } else if (isEvening) {
      prompt.push(
        `TIME CONSTRAINT: It's evening (6-8 PM).`,
        `- Focus on: tonight's rush, driver allocation, wait times`,
        `- Avoid: marketing campaigns, tomorrow's prep`,
        ``
      );
    } else {
      prompt.push(
        `TIME CONSTRAINT: It's ${localHour < 12 ? 'morning' : 'afternoon'}.`,
        `- Can suggest: full-day operations, prep work, promotions`,
        ``
      );
    }
  
    prompt.push(
      `IMPORTANT: Only reference data that is explicitly provided above. Do not invent or assume any events, traffic conditions, or other factors not mentioned in the CURRENT CONDITIONS section.`,
      ``,
      `GENERATE JSON RESPONSE:`,
      `{`,
      `  "insight": "Connect multiple factors for non-obvious impact (e.g., 'Lakers game + rain = 60% surge, extend all shifts')",`,
      `  "severity": "info" OR "warning" OR "critical",`,
      `  "metrics": {`,
      `    "expectedOrderIncrease": 0-100 (percentage),`,
      `    "recommendedExtraDrivers": 0-10 (whole number),`,
      `    "peakHours": "HH-HH" format or null,`,
      `    "primaryReason": "the main factor driving this recommendation"`,
      `  },`,
      `  "todayActions": "What manager can do THIS INSTANT at ${localDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}",`,
      `  "weekOutlook": "5-day forecast with specific dates/events (max 100 chars)"`,
      `}`,
      ``,
      `PRIORITY ORDER FOR DECISIONS:`,
      `1. Multiple simultaneous factors (event + weather + traffic)`,
      `2. Event timing collisions (multiple venues letting out together)`,
      `3. Major single events within 5 miles`,
      `4. Severe weather conditions`,
      `5. Traffic delays over 15 minutes`,
      ``,
      `INSIGHT REQUIREMENTS:`,
      `- Connect 2+ factors when they compound each other`,
      `- Mention specific roads/exits for traffic impacts`,
      `- Note when multiple events end at same time`,
      `- Include historical patterns when relevant (e.g., "Friday rain typically +40% orders")`,
      `2. Severe weather conditions`,
      `3. Traffic delays over 15 minutes`,
      `4. Holidays in next 3 days`,
      `5. Store type patterns`,
      ``,
      `Base your recommendation on the highest-priority factor present.`
    );
  
    return prompt.join('\n');
  }
  
  // Helper method to process events cleanly
  processEventsForPrompt(events) {
    if (!events || events.length === 0) {
      return { hasEvents: false, summary: null };
    }
    
    const processedEvents = events.map(e => {
      const date = new Date(e.date);
      const dateStr = date.toLocaleDateString('en-US', { 
        weekday: 'short', 
        month: 'short', 
        day: 'numeric' 
      });
      return `${dateStr}: ${e.name} at ${e.venue}`;
    });
    
    return {
      hasEvents: true,
      summary: processedEvents.join('; ')
    };
  }
  
// Helper to make events more detailed for the prompt
enhanceEventDetails(events) {
  if (!events || events.length === 0) return [];
  
  return events.map(event => {
    const eventDate = new Date(event.date);
    const eventTime = event.time || '19:00:00';
    const [hours, minutes] = eventTime.split(':');
    const eventEndTime = parseInt(hours) + 3; // Assume 3-hour events
    
    return {
      ...event,
      fullDescription: `${event.name} at ${event.venue} (${event.type})`,
      startTime: `${parseInt(hours) > 12 ? parseInt(hours) - 12 : hours}:${minutes} ${parseInt(hours) >= 12 ? 'PM' : 'AM'}`,
      estimatedEndTime: `${eventEndTime > 12 ? eventEndTime - 12 : eventEndTime}:00 ${eventEndTime >= 12 ? 'PM' : 'AM'}`,
      crowdImpact: event.capacity > 10000 ? 'major event - expect high demand' : 
             event.capacity > 5000 ? 'medium event - expect increased orders' : 
             'local event - some impact expected'
    };
  });
}


analyzeMultipleFactors(data, localHour, localDate) {
  const factors = [];
  
  // Check for event collisions
  if (data.events && data.events.length > 1) {
    const sameTimeEvents = data.events.filter(e => {
      const eventTime = new Date(e.date + ' ' + e.time);
      return Math.abs(eventTime.getHours() - localHour) < 2;
    });
    
    if (sameTimeEvents.length > 1) {
      factors.push(`Multiple events ending simultaneously: ${sameTimeEvents.map(e => e.name).join(' + ')}`);
    }
  }
  
  // Weather + event combo
  if (data.weather && data.events && data.events.length > 0) {
    if (data.weather.condition.toLowerCase().includes('rain')) {
      factors.push(`Rain + ${data.events[0].name} = perfect storm conditions`);
    }
  }
  
  // Traffic + specific routes
  if (data.traffic && data.traffic.delayMinutes > 15) {
    factors.push(`Major traffic delays (${data.traffic.delayMinutes} min) affecting driver routes`);
  }
  
  // Day of week patterns
  const dayName = localDate.toLocaleDateString('en-US', { weekday: 'long' });
  if (dayName === 'Friday' && data.events && data.events.length > 0) {
    factors.push(`Friday night + events = compound surge expected`);
  }
  
  return factors;
}





  async retryOpenAI(fn, retries = 2) {
    try {
      return await fn();
    } catch (error) {
      if (retries === 0 || error.status !== 429) throw error;
      await new Promise(resolve => setTimeout(resolve, 2000));
      return this.retryOpenAI(fn, retries - 1);
    }
  }

  // Enhanced AI call with better error handling
  async generateAIInsight(store, data) {
    const prompt = await this.buildIntelligencePrompt(store, data);
    
    console.log(`\n=== AI PROMPT for Store ${store.store_id || store.id} ===`);
    console.log(prompt);
    console.log('=== END PROMPT ===\n');
    
    try {
      // Simple rate limiting
        const now = Date.now();
        const timeSinceLastCall = now - this.lastApiCall;
        if (timeSinceLastCall < this.minApiDelay) {
          await new Promise(resolve => setTimeout(resolve, this.minApiDelay - timeSinceLastCall));
        }
        this.lastApiCall = Date.now();

        const completion = await this.retryOpenAI(async () => {
          return await this.openai.chat.completions.create({
        model: this.config.ai.model,
        messages: [
          {
            role: "system",
            content: "You are an AI assistant for Domino's Pizza operations. Provide practical, actionable insights for store managers. Always respond with valid JSON matching the requested format."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.7, // Lower for more consistent outputs
        max_tokens: this.config.ai.maxTokens,
        response_format: { type: "json_object" }
      });
    });
  
      const aiResponse = JSON.parse(completion.choices[0].message.content);
      
      // Validate and clean the response
      const validatedResponse = this.validateAIResponse(aiResponse);
      
      console.log(`\n=== AI RESPONSE for Store ${store.store_id || store.id} ===`);
      console.log(JSON.stringify(validatedResponse, null, 2));
      console.log('=== END RESPONSE ===\n');
      
      return validatedResponse;
    } catch (error) {
      console.error('OpenAI API error:', error);
      return this.getFallbackInsight(store);
    }
  }
  
  // Add this new validation method
  validateAIResponse(response) {
    // Ensure all required fields exist with proper types
    const validated = {
      insight: String(response.insight || "Monitor standard operations").substring(0, 100),
      severity: ["info", "warning", "critical"].includes(response.severity) ? response.severity : "info",
      metrics: {
        expectedOrderIncrease: Math.min(100, Math.max(0, Number(response.metrics?.expectedOrderIncrease) || 0)),
        recommendedExtraDrivers: Math.min(10, Math.max(0, Math.floor(Number(response.metrics?.recommendedExtraDrivers) || 0))),
        peakHours: response.metrics?.peakHours || null,
        primaryReason: String(response.metrics?.primaryReason || "standard operations")
      },
      todayActions: String(response.todayActions || "Follow standard procedures").substring(0, 80),
      weekOutlook: String(response.weekOutlook || "Monitor daily conditions").substring(0, 100)
    };
    
    return validated;
  }

  /**
   * Fixed: Get store local time using proper timezone conversion
   * Following the pattern: storeLocalTime = UTC + offsetMinutes
   */
  getStoreLocalTime(store) {
    const now = new Date();
    const offsetMinutes = this.fixedOffsetToMinutes(store.time_zone_code);
    
    // Critical: Use + for display (not -)
    const storeLocalTimeMs = now.getTime() + (offsetMinutes * 60000);
    
    // Extract components manually to avoid JS Date timezone issues
    const totalMinutes = Math.floor(storeLocalTimeMs / 60000);
    const dayMinutes = ((totalMinutes % (24 * 60)) + (24 * 60)) % (24 * 60);
    const hours = Math.floor(dayMinutes / 60);
    const minutes = dayMinutes % 60;
    
    // Get the date components
    const storeDate = new Date(storeLocalTimeMs);
    const year = storeDate.getUTCFullYear();
    const month = storeDate.getUTCMonth();
    const day = storeDate.getUTCDate();
    
    // Create a date string in store local time
    const localDateTime = new Date(Date.UTC(year, month, day, hours, minutes));
    return localDateTime.toISOString();
  }

  /**
   * Fixed: Parse timezone offset string to minutes
   * Replaced getStoreOffset with proper implementation
   */
  fixedOffsetToMinutes(offsetStr) {
    if (!offsetStr) return -480; // Default to PST if no timezone
    
    const match = offsetStr.match(/GMT([+-])(\d{2}):(\d{2})/);
    if (!match) return -480; // Default to PST if invalid format
    
    const sign = match[1] === '+' ? 1 : -1;
    const hours = parseInt(match[2], 10);
    const mins = parseInt(match[3], 10);
    return sign * (hours * 60 + mins);
  }


  async getStoreBaselines(store) {
  // Use data directly from the store object (locations table)
  return {
    delivery: { 
      min: store.estimated_wait_minutes || 25, 
      max: (store.estimated_wait_minutes || 25) + 20 
    },
    carryout: { 
      min: 15, 
      max: 25 
    },
    minOrder: store.minimum_delivery_order_amount || 15
  };
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
      data: data,
      timestamp: Date.now()
    });
  }
  
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 3959;
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

  async generateBatchInsights(stores, batchSize = 3) {
  const results = [];
  for (let i = 0; i < stores.length; i += batchSize) {
    const batch = stores.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(store => 
        this.generateStoreInsight(store).catch(err => {
          console.error(`Failed for store ${store.store_id || store.id}:`, err);
          return this.getFallbackInsight(store);
        })
      )
    );
    results.push(...batchResults);
    // Delay between batches to avoid rate limits
    if (i + batchSize < stores.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  return results;
}
}

module.exports = StoreIntelligenceService;