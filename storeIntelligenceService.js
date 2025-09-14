const axios = require('axios');
const OpenAI = require('openai');
const config = require('./intelligenceConfig');

class StoreIntelligenceService {
  constructor(openAIKey, googleMapsKey, weatherService, dbPool) {
    this.openai = new OpenAI({ apiKey: openAIKey });
    this.googleMapsKey = googleMapsKey;
    this.weatherService = weatherService;
    this.dbPool = dbPool; // Add database connection
    this.cache = new Map();
    this.config = config;
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
      
      const response = await axios.get(
        'https://maps.googleapis.com/maps/api/directions/json', {
          params: {
            origin: `${store.latitude},${store.longitude}`,
            destination: `${store.latitude + kmToDegrees},${store.longitude + kmToDegrees}`,
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

  buildIntelligencePrompt(store, data) {
    const now = new Date();
    const localTime = this.getStoreLocalTime(store);
    const baselines = await this.getStoreBaselines(store.store_id);
    
    return `You are Domino's Store Mentor. Generate ONE actionable insight for store ${store.store_id}.

Store Context:
- Location: ${store.city}, ${store.state}
- Type: ${data.storeType.type}
- Local Time: ${localTime}
- Open Shifts: ${store.shifts?.open || 0}
- Booked Shifts: ${store.shifts?.booked || 0}

Current Data:
- Weather: ${data.weather ? `${data.weather.temperature}°F, ${data.weather.condition}` : 'unavailable'}
- Traffic: ${data.traffic ? `${data.traffic.delayMinutes} min delays` : 'normal'}
- Holidays (next 7 days): ${data.holidays?.slice(0,3).map(h => h.name).join(', ') || 'none'}

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

  // Helper methods remain the same...
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
    if (!store.latitude || !store.longitude) return null;
    
    for (const location of locations) {
      const distance = this.calculateDistance(
        store.latitude,
        store.longitude,
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