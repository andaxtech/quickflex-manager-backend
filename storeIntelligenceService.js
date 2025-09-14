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
  }

  async generateStoreInsight(store) {
    try {
      if (!store.store_latitude || !store.store_longitude) {
        console.warn(`Store ${store.store_id} missing coordinates`);
        return this.getFallbackInsight(store);
      }

      const dataPromises = [
        this.weatherService.getWeatherByCity(store.city, store.region || store.state, store),
        this.getTrafficData(store),
        this.getHolidays(),
        this.getLocalEvents(store)
      ];

      const results = await Promise.allSettled(dataPromises);

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
    const dbClassification = await this.getStoreClassification(store.store_id);
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
      await this.saveStoreClassification(store.store_id, classification);
      
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
  await this.saveStoreClassification(store.store_id, classification);
  
  return classification;
}

const classification = {
  type: 'suburban',
  subType: 'standard',
  patterns: await this.getPatternsByType('suburban')
};

// Save to database
await this.saveStoreClassification(store.store_id, classification);

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
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
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
    const cacheKey = `traffic_${store.store_id}`;
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

  async getLocalEvents(store) {
    const cacheKey = `events_${store.store_id}`;
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
        radius: '15',
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

  async generateAIInsight(store, data) {
    const prompt = await this.buildIntelligencePrompt(store, data);
    
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
    
    let eventsSummary = 'No major events';
let eventDetails = [];
if (data.events && data.events.length > 0) {
  eventDetails = data.events.map(e => {
    const dateObj = new Date(e.date);
    const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    return {
      description: `${dayName}: ${e.name} at ${e.venue} (${e.type})`,
      impact: e.impact,
      capacity: e.capacity
    };
  });
  eventsSummary = eventDetails.map(e => e.description).join('; ');
}
    
    const promptParts = [
      `You are Domino's Store Mentor. Generate ONE actionable insight for store ${store.store_id}.`,
      '',
      'Store Context:',
      `- Location: ${store.city}, ${store.region || store.state}`,
      `- Type: ${data.storeType.type}`,
      `- Local Time: ${localTime}`,
      `- Open Shifts: ${store.shifts?.open || 0}`,
      `- Booked Shifts: ${store.shifts?.booked || 0}`,
      '',
      'Current Data:',
      `- Weather: ${data.weather ? data.weather.temperature + '°F, ' + data.weather.condition : 'unavailable'}`,
      `- Traffic: ${data.traffic ? data.traffic.delayMinutes + ' min delays' : 'normal'}`,
      `- Holidays (next 7 days): ${data.holidays?.slice(0,3).map(h => h.name).join(', ') || 'none'}`,
      `- Local Events: ${eventsSummary}`,
      ''
      ];

      // Add specific traffic alert if significant delays
      if (data.traffic && data.traffic.delayMinutes > 10) {
        promptParts.push(`- Traffic Alert: Major delays on nearby routes (${data.traffic.delayMinutes} min)`);
        promptParts.push('');
      }
    

    if (data.events && data.events.length > 0) {
      promptParts.push('EVENT IMPACT: Major events detected nearby that will drive pizza demand.');
      promptParts.push('');
    }

    promptParts.push('Baselines:');
    promptParts.push(`- Delivery: ${baselines.delivery.min}-${baselines.delivery.max} minutes`);
    promptParts.push(`- Carryout: ${baselines.carryout.min}-${baselines.carryout.max} minutes`);
    promptParts.push(`- Min delivery: $${baselines.minOrder}`);
    promptParts.push('');
    promptParts.push('Return JSON with:');
promptParts.push('{');
promptParts.push('  "insight": "specific action for NOW - MUST include event name/reason (max 100 chars)",');
promptParts.push('  "severity": "info|warning|critical",');
promptParts.push('  "metrics": {');
promptParts.push('    "expectedOrderIncrease": percentage,');
promptParts.push('    "recommendedExtraDrivers": number,');
promptParts.push('    "peakHours": "17-20" or null,');
promptParts.push('    "primaryReason": "specific cause (e.g., Lakers game, I-405 accident, Veterans Day)"');
promptParts.push('  },');
promptParts.push('  "todayActions": "what to do TODAY with specific reason (max 80 chars)",');
promptParts.push('  "weekOutlook": "5-day forecast with SPECIFIC events/dates mentioned (max 100 chars)"');
promptParts.push('}');
promptParts.push('');
promptParts.push('REQUIREMENTS:');
promptParts.push('- Always mention specific event names (e.g., "Taylor Swift at SoFi Stadium")');
promptParts.push('- Include specific roads for traffic (e.g., "I-405 accident causing 45min delays")');
promptParts.push('- Name specific holidays or dates (e.g., "Veterans Day surge on Nov 11")');
promptParts.push('- Never be vague - managers need verifiable details');
    promptParts.push('  "severity": "info|warning|critical",');
    promptParts.push('  "metrics": {');
    promptParts.push('    "expectedOrderIncrease": percentage,');
    promptParts.push('    "recommendedExtraDrivers": number,');
    promptParts.push('    "peakHours": "17-20" or null');
    promptParts.push('  },');
    promptParts.push('  "todayActions": "what to do TODAY (max 80 chars)",');
    promptParts.push('  "weekOutlook": "5-day forecast impact (max 80 chars)"');
    promptParts.push('}');

    return promptParts.join('\n');
  }

  async getStoreBaselines(storeId) {
    try {
      const query = `SELECT 
        delivery_min_minutes, 
        delivery_max_minutes,
        carryout_min_minutes,
        carryout_max_minutes,
        minimum_delivery_order_amount
      FROM store_baselines 
      WHERE store_id = $1`;
      
      const result = await this.dbPool.query(query, [storeId]);

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
    if (!store.time_zone_code) return -480;
    
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
}

module.exports = StoreIntelligenceService;