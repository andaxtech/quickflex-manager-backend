module.exports = {
    // Model configuration
    ai: {
      model: process.env.AI_MODEL || 'gpt-4o-mini',
      temperature: 0.3,
      maxTokens: 800
    },
  
    // Cache TTLs in milliseconds
    cache: {
      traffic: parseInt(process.env.TRAFFIC_CACHE_TTL || 600000), // 10 min default
      holidays: parseInt(process.env.HOLIDAYS_CACHE_TTL || 86400000), // 24 hour default
      events: parseInt(process.env.EVENTS_CACHE_TTL || 3600000) // 1 hour default
    },
  
    // Location data - should eventually come from database
    locations: {
      militaryBases: {
        'CA': [
          { name: 'Camp Pendleton', lat: 33.2341, lng: -117.3897, radius: 20 },
          { name: 'Travis AFB', lat: 38.2627, lng: -121.9275, radius: 15 },
          { name: 'Naval Base San Diego', lat: 32.6859, lng: -117.1831, radius: 15 }
        ]
      },
      colleges: {
        'CA': [
          { name: 'UC Berkeley', lat: 37.8719, lng: -122.2585, radius: 5 },
          { name: 'UCLA', lat: 34.0689, lng: -118.4452, radius: 5 },
          { name: 'Stanford', lat: 37.4275, lng: -122.1697, radius: 5 }
        ]
      }
    },
  
    // Traffic sampling configuration
    traffic: {
      sampleDistanceKm: parseFloat(process.env.TRAFFIC_SAMPLE_DISTANCE || 5),
      congestionThresholds: {
        heavy: 10, // minutes delay
        moderate: 5
      }
    },
  
    // Store baselines (should come from database per store)
    baselines: {
      deliveryMinutes: { min: 14, max: 29 },
      carryoutMinutes: { min: 7, max: 17 },
      minDeliveryOrder: 10,
      cashLimit: 50
    }
  };