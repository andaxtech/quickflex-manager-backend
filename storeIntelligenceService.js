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
    this.rateLimiter = {
      general: { lastCall: 0, minDelay: 100 },
      ticketmaster: { lastCall: 0, minDelay: 1000 },
      google: { lastCall: 0, minDelay: 100 }
    };
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
      const insight = await this.generateAIInsight(normalizedStore, externalData, storeContext);
      
      // Return both insight and raw data
      return {
        ...insight,
        // Include the raw external data for the frontend
        _externalData: externalData
      };
      
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
      minOrder: store.minimum_delivery_order_amount || 15
    };
  }

  validateStore(store) {
    return store.id && store.city && store.state && 
           !isNaN(store.lat) && !isNaN(store.lng);
  }

  async collectExternalData(store) {
    console.log(`📊 Collecting external data for store ${store.id}...`);
    
    const [weather, traffic, events, boostWeek, slowPeriod] = await Promise.allSettled([
      this.getWeatherData(store),
      this.getTrafficData(store),
      this.getEventData(store),
      this.detectBoostWeekOpportunity(store),
      this.analyzeSlowPeriod(store)
    ]);
    
    // Log what we got
    console.log(`✅ Weather data:`, weather.status === 'fulfilled' ? 'Success' : 'Failed');
    console.log(`✅ Traffic data:`, traffic.status === 'fulfilled' ? 'Success' : 'Failed');
    console.log(`✅ Events data:`, events.status === 'fulfilled' ? 'Success' : 'Failed');
    console.log(`✅ Boost week:`, boostWeek.status === 'fulfilled' ? 'Success' : 'Failed');
    console.log(`✅ Slow period:`, slowPeriod.status === 'fulfilled' ? 'Success' : 'Failed');
  
    const collectedData = {
      weather: weather.status === 'fulfilled' ? weather.value : null,
      traffic: traffic.status === 'fulfilled' ? traffic.value : null,
      events: events.status === 'fulfilled' ? events.value : [],
      boostWeek: boostWeek.status === 'fulfilled' ? boostWeek.value : null,
      slowPeriod: slowPeriod.status === 'fulfilled' ? slowPeriod.value : null
    };
    
    

      // Check for upcoming holidays
      const upcomingHoliday = await this.getUpcomingHoliday();
      if (upcomingHoliday) {
        collectedData.upcomingHoliday = upcomingHoliday;
      }

      return collectedData;
  }

  async getWeatherData(store) {
    try {
      const weather = await this.weatherService.getWeatherByCity(
        store.city, 
        store.state, 
        store
      );
      
      if (!weather) return null;
      
      const weatherData = {
        temp: Math.round(weather.temperature),
        condition: weather.condition,
        isRaining: weather.condition.toLowerCase().includes('rain'),
        isSevere: weather.condition.toLowerCase().match(/storm|snow|blizzard/)
      };
      
      weatherData.carryoutOpportunity = this.calculateCarryoutOpportunity('weather', weatherData);
      
      return weatherData;
    } catch (error) {
      console.error('Weather fetch error:', error);
      return null;
    }
  }


// ADD THIS NEW METHOD HERE
calculateCarryoutOpportunity(trigger, data) {
  const opportunities = {
    weather: {
      rain: { discount: 30, margin: 15, message: "Beat the rain! 30% off when you pick up" },
      severe: { discount: 50, margin: 15, message: "Skip the storm! 50% off all carryout orders" }
    },
    slowPeriod: {
      afternoon: { discount: 20, margin: 10, message: "Afternoon special - 20% off carryout" }
    }
  };

  let opportunity = null;
  
  if (trigger === 'weather' && data.isSevere) {
    opportunity = { ...opportunities.weather.severe, reason: 'severe weather' };
  } else if (trigger === 'weather' && data.isRaining) {
    opportunity = { ...opportunities.weather.rain, reason: 'rain' };
  } else if (trigger === 'slowPeriod' && data.name === 'afternoon') {
    opportunity = { ...opportunities.slowPeriod.afternoon, reason: 'slow period' };
  }

  return opportunity ? { isActive: true, ...opportunity } : null;
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

  async getTicketmasterEvents(store) {
    const cacheKey = `events_${store.id}`;
    const cached = this.getCached(cacheKey, 3600000); // 1 hour cache
    if (cached) return cached;
  
    try {
      const tmApiKey = process.env.TICKETMASTER_API_KEY;
      if (!tmApiKey) return [];
  
      
      // Rate limit protection for Ticketmaster API
      await this.enforceRateLimit('ticketmaster');
  
      const response = await axios.get('https://app.ticketmaster.com/discovery/v2/events.json', {
        params: {
          apikey: tmApiKey,
          latlong: `${store.lat},${store.lng}`,
          radius: '25',
          unit: 'miles',
          size: 20,  // Increased from 10
          sort: 'date,asc',
          startDateTime: new Date().toISOString(),
          endDateTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        },
        timeout: 5000
      });
      
      // Debug logging
      console.log(`🎫 Events API for store ${store.id} (${store.city}):`, {
        totalFound: response.data.page?.totalElements || 0,
        returned: response.data._embedded?.events?.length || 0
      });
      
      if (!response.data._embedded?.events) return [];
      
      // Log all events before filtering
      response.data._embedded.events.forEach(event => {
        // Ticketmaster provides ISO datetime with timezone
        const eventDate = new Date(event.dates.start.dateTime);

        // Debug logging
        console.log(`Event ${event.name} time:`, {
          raw: event.dates.start.dateTime,
          parsed: eventDate.toISOString(),
          local: eventDate.toLocaleString()
        });
        console.log(`  - ${event.name} | ${eventDate.toLocaleDateString()} | Venue: ${event._embedded?.venues?.[0]?.name}`);
      });

      const processedEvents = response.data._embedded.events
  .map(event => this.processEvent(event));

      // Log impact scores
      console.log('📊 Event impact scores:');
      processedEvents.forEach(e => {
        
      });

      const events = processedEvents
        .filter(event => {
          // Lower threshold to catch more events
          return event.impact >= 0.3 || event.isToday;
        })
        .slice(0, 10); // Show more events

      console.log(`✅ Filtered to ${events.length} relevant events`);

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

  async getEventData(store) {
    const cacheKey = `events_${store.id}`;
    const cached = this.getCached(cacheKey, 3600000); // 1 hour cache
    if (cached) return cached;

    console.log(`🎪 Fetching events from multiple sources for store ${store.id}...`);

    // Fetch from all sources in parallel
    const [ticketmaster, seatgeek, eventbrite, googlePlaces] = await Promise.allSettled([
      this.getTicketmasterEvents(store),
      this.getSeatGeekEvents(store),
      this.getEventbriteEvents(store),
      this.getGooglePlacesEvents(store)
    ]);

    // Combine results
    const allEvents = [
      ...(ticketmaster.status === 'fulfilled' ? ticketmaster.value : []),
      ...(seatgeek.status === 'fulfilled' ? seatgeek.value : []),
      ...(eventbrite.status === 'fulfilled' ? eventbrite.value : []),
      ...(googlePlaces.status === 'fulfilled' ? googlePlaces.value : [])
    ];

    console.log(`📊 Event sources summary:
      - Ticketmaster: ${ticketmaster.status === 'fulfilled' ? ticketmaster.value.length : 'failed'}
      - SeatGeek: ${seatgeek.status === 'fulfilled' ? seatgeek.value.length : 'failed'}
      - Eventbrite: ${eventbrite.status === 'fulfilled' ? eventbrite.value.length : 'failed'}
      - Google Places: ${googlePlaces.status === 'fulfilled' ? googlePlaces.value.length : 'failed'}
      - Total: ${allEvents.length} events found`);

    // Deduplicate events
    const uniqueEvents = this.deduplicateEvents(allEvents);
    
    // Sort by date and filter
    const finalEvents = uniqueEvents
      .sort((a, b) => a.date - b.date)
      .filter(event => event.impact >= 0.3 || event.isToday)
      .slice(0, 10);

    this.setCache(cacheKey, finalEvents);
    return finalEvents;
  }

  deduplicateEvents(events) {
    const seen = new Map();
    return events.filter(event => {
      // Create a key based on venue, date, and similar time
      const dateKey = event.date.toDateString();
      const hourKey = Math.floor(event.date.getHours() / 2) * 2; // Group by 2-hour blocks
      const key = `${event.venue.toLowerCase()}-${dateKey}-${hourKey}`;
      
      if (seen.has(key)) {
        // Keep the one with more details
        const existing = seen.get(key);
        if (event.capacity > existing.capacity) {
          seen.set(key, event);
        }
        return false;
      }
      
      seen.set(key, event);
      return true;
    });
  }

  async getSeatGeekEvents(store) {
    try {
      const sgClientId = process.env.SEATGEEK_CLIENT_ID;
      if (!sgClientId) return [];
  
      const response = await axios.get('https://api.seatgeek.com/2/events', {
        params: {
          client_id: sgClientId,
          lat: store.lat,
          lon: store.lng,
          range: '25mi',
          per_page: 20,
          type: 'concert,sports,theater',
          datetime_utc: {
            gte: new Date().toISOString().split('T')[0]
          }
        }
      });
  
      if (!response.data.events) return [];
  
      return response.data.events.map(event => {
        const eventDate = new Date(event.datetime_utc);
        const capacity = event.venue.capacity || 5000;
        
        return {
          name: event.title,
          venue: event.venue.name,
          date: eventDate,
          time: eventDate.toLocaleTimeString('en-US', { 
            hour: '2-digit', 
            minute: '2-digit' 
          }),
          capacity: capacity,
          type: event.type,
          impact: this.calculateEventImpact(capacity, eventDate),
          hoursUntilEvent: (eventDate - new Date()) / (1000 * 60 * 60),
          daysUntilEvent: Math.floor((eventDate - new Date()) / (1000 * 60 * 60 * 24)),
          isToday: (eventDate - new Date()) / (1000 * 60 * 60) >= -12 && (eventDate - new Date()) / (1000 * 60 * 60) < 24,
          source: 'seatgeek',
          preEventWindow: {
            start: new Date(eventDate.getTime() - (3 * 60 * 60 * 1000)),
            end: new Date(eventDate.getTime() - (30 * 60 * 1000)),
            expectedOrders: Math.floor(capacity * 0.005),
            staffingNeeded: Math.ceil((capacity * 0.005) / 20)
          },
          postEventWindow: {
            start: eventDate,
            end: new Date(eventDate.getTime() + (2 * 60 * 60 * 1000)),
            peakTime: new Date(eventDate.getTime() + (45 * 60 * 1000)),
            expectedOrders: Math.floor(capacity * 0.01),
            staffingNeeded: Math.ceil((capacity * 0.01) / 15)
          }
        };
      });
    } catch (error) {
      console.error('SeatGeek API error:', error);
      return [];
    }
  }

  async getEventbriteEvents(store) {
    try {
      const ebPublicToken = process.env.EVENTBRITE_PUBLIC_TOKEN || process.env.EVENTBRITE_TOKEN;
      const ebApiKey = process.env.EVENTBRITE_API_KEY;
      
      if (!ebPublicToken && !ebApiKey) {
        console.log('No Eventbrite credentials configured');
        return [];
      }
  
      const authHeader = ebPublicToken 
        ? `Bearer ${ebPublicToken}`
        : `Bearer ${ebApiKey}`;
  
      // Note: Eventbrite's public API has limitations
      // Try location-based search first
      let response;
      try {
        response = await axios.get('https://www.eventbriteapi.com/v3/events/search/', {
          headers: {
            'Authorization': authHeader,
          },
          params: {
            'location.address': `${store.city}, ${store.state}`,
            'location.within': '25mi',
            'expand': 'venue'
          }
        });
      } catch (err) {
        // If location search fails, try without location params
        console.log('Eventbrite location search failed, trying general search');
        response = await axios.get('https://www.eventbriteapi.com/v3/events/', {
          headers: {
            'Authorization': authHeader,
          }
        });
      }
  
      if (!response.data.events) return [];
  
      return response.data.events
        .filter(event => {
          // Manual distance filtering if needed
          const eventLat = event.venue?.latitude;
          const eventLng = event.venue?.longitude;
          if (eventLat && eventLng) {
            const distance = this.calculateDistance(store.lat, store.lng, eventLat, eventLng);
            return distance <= 25; // 25 miles
          }
          return true; // Include if no venue coords
        })
        .slice(0, 10)
        .map(event => {
          const eventDate = new Date(event.start.utc);
          const capacity = event.capacity || 5000;
          
          return {
            name: event.name.text,
            venue: event.venue?.name || 'TBD',
            date: eventDate,
            time: eventDate.toLocaleTimeString('en-US', { 
              hour: '2-digit', 
              minute: '2-digit' 
            }),
            capacity: capacity,
            type: 'Event',
            impact: this.calculateEventImpact(capacity, eventDate),
            hoursUntilEvent: (eventDate - new Date()) / (1000 * 60 * 60),
            daysUntilEvent: Math.floor((eventDate - new Date()) / (1000 * 60 * 60 * 24)),
            isToday: (eventDate - new Date()) / (1000 * 60 * 60) >= -12 && 
                     (eventDate - new Date()) / (1000 * 60 * 60) < 24,
            source: 'eventbrite',
            preEventWindow: {
              start: new Date(eventDate.getTime() - (3 * 60 * 60 * 1000)),
              end: new Date(eventDate.getTime() - (30 * 60 * 1000)),
              expectedOrders: Math.floor(capacity * 0.005),
              staffingNeeded: Math.ceil((capacity * 0.005) / 20)
            },
            postEventWindow: {
              start: eventDate,
              end: new Date(eventDate.getTime() + (2 * 60 * 60 * 1000)),
              peakTime: new Date(eventDate.getTime() + (45 * 60 * 1000)),
              expectedOrders: Math.floor(capacity * 0.01),
              staffingNeeded: Math.ceil((capacity * 0.01) / 15)
            }
          };
        });
    } catch (error) {
      console.error('Eventbrite API error:', error.response?.status, error.response?.data?.error_description || error.message);
      return [];
    }
  }

  async getGooglePlacesEvents(store) {
    try {
      const response = await axios.get('https://maps.googleapis.com/maps/api/place/nearbysearch/json', {
        params: {
          location: `${store.lat},${store.lng}`,
          radius: 40000,
          type: 'stadium',
          key: this.googleMapsKey
        }
      });
  
      if (!response.data.results) return [];
  
      const venues = response.data.results.slice(0, 5).map(place => {
        const eventDate = new Date();
        const capacity = place.user_ratings_total ? place.user_ratings_total * 10 : 5000;
        
        return {
          name: `Event at ${place.name}`,
          venue: place.name,
          date: eventDate,
          time: 'Various',
          capacity: capacity,
          type: 'Venue Activity',
          impact: 0.5,
          hoursUntilEvent: 0,
          daysUntilEvent: 0,
          isToday: true,
          source: 'google_places',
          preEventWindow: {
            start: new Date(eventDate.getTime() - (3 * 60 * 60 * 1000)),
            end: new Date(eventDate.getTime() - (30 * 60 * 1000)),
            expectedOrders: Math.floor(capacity * 0.005),
            staffingNeeded: Math.ceil((capacity * 0.005) / 20)
          },
          postEventWindow: {
            start: eventDate,
            end: new Date(eventDate.getTime() + (2 * 60 * 60 * 1000)),
            peakTime: new Date(eventDate.getTime() + (45 * 60 * 1000)),
            expectedOrders: Math.floor(capacity * 0.01),
            staffingNeeded: Math.ceil((capacity * 0.01) / 15)
          }
        };
      });
  
      return venues;
    } catch (error) {
      console.error('Google Places error:', error);
      return [];
    }
  }

  processEvent(event) {
    const venue = event._embedded?.venues?.[0];
    const capacity = parseInt(venue?.capacity) || 5000;
    const eventDate = new Date(event.dates.start.dateTime);
    
    const now = new Date();
    const hoursUntilEvent = (eventDate - now) / (1000 * 60 * 60);
    const daysUntilEvent = Math.floor(hoursUntilEvent / 24);
  
    // Include today's events (negative hours mean event has passed today)
    const isToday = hoursUntilEvent >= -12 && hoursUntilEvent < 24;
  
    const eventData = {
      name: event.name,
      venue: venue?.name || 'Unknown',
      date: eventDate,
      time: eventDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      capacity,
      type: event.classifications?.[0]?.segment?.name || 'Event',
      impact: this.calculateEventImpact(capacity, eventDate),
      hoursUntilEvent,
      daysUntilEvent,
      isToday,
      isPastToday: hoursUntilEvent < 0 && hoursUntilEvent >= -12,
      
      // Specific timing insights
      preEventWindow: {
        start: new Date(eventDate.getTime() - (3 * 60 * 60 * 1000)), // 3 hours before
        end: new Date(eventDate.getTime() - (30 * 60 * 1000)), // 30 min before
        expectedOrders: Math.floor(capacity * 0.005), // 0.5% of attendees
staffingNeeded: Math.ceil((capacity * 0.005) / 20) // 1 driver per 20 orders
      },
      
      postEventWindow: {
        start: eventDate,
        end: new Date(eventDate.getTime() + (2 * 60 * 60 * 1000)), // 2 hours after
        peakTime: new Date(eventDate.getTime() + (45 * 60 * 1000)), // 45 min after
        expectedOrders: Math.floor(capacity * 0.01), // 1% of attendees
staffingNeeded: Math.ceil((capacity * 0.01) / 15) // 1 driver per 15 orders (rush)
      }
    };
  
    // Add pre-order opportunity for events 2-7 days out
    eventData.preOrderOpportunity = this.createPreOrderOpportunity(eventData);
  
    return eventData;
  }



  // ADD THESE TWO NEW METHODS HERE
  createPreOrderOpportunity(event) {
    if (event.daysUntilEvent < 2 || event.daysUntilEvent > 7 || event.capacity <= 5000) {
      return null;
    }
    
    const urgency = event.daysUntilEvent <= 3 ? 'HIGH' : 'MEDIUM';
    const targetOrders = Math.floor(event.capacity * 0.01); // More realistic 1%
    
    return {
      isActive: true,
      urgency,
      targetOrders,
      suggestedCampaign: this.getPreOrderCampaign(event),
    };
  }

  getPreOrderCampaign(event) {
    const campaigns = {
      'HIGH': {
        message: `${event.name} is THIS WEEK! Order now for gameday delivery`,
        channel: 'email + SMS blast',
        timing: 'Send immediately'
      },
      'MEDIUM': {
        message: `Planning for ${event.name}? Pre-order your pizzas now!`,
        channel: 'email campaign',
        timing: 'Send tomorrow morning'
      }
    };
    
    const urgency = event.daysUntilEvent <= 3 ? 'HIGH' : 'MEDIUM';
    return campaigns[urgency];
  }





  //calculate event impact

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


  // ADD THIS NEW METHOD HERE
  aggregateEventImpact(events) {
    const totalCapacity = events.reduce((sum, e) => sum + e.capacity, 0);
    const avgImpact = events.length > 0 
      ? events.reduce((sum, e) => sum + e.impact, 0) / events.length 
      : 0;
    
    return {
      totalCapacity,
      avgImpact,
      isMajor: totalCapacity > 20000 || avgImpact > 0.7,
      count: events.length
    };
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
      isPeakTime: this.isPeakHour(localTime.getHours()),
isLateNight: this.isLateNightHour(localTime.getHours()),
isSlowPeriod: this.isSlowPeriod(localTime.getHours(), localTime.getDay())
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


  async detectBoostWeekOpportunity(store) {
    const cacheKey = `boost_week_${store.id}`;
    const cached = this.getCached(cacheKey, 86400000); // 24 hour cache
    if (cached) return cached;
  
    try {
      // Get current date info
      const now = new Date();
      const month = now.toLocaleString('en-US', { month: 'long' }).toLowerCase();
      const weekOfMonth = Math.ceil(now.getDate() / 7);
      const daysSinceHoliday = await this.getDaysSinceLastHoliday(now);
      
      // Check for Domino's boost week patterns
      const boostWeekIndicators = {
        isHighProbabilityPeriod: false,
        confidence: 0,
        reasons: [],
        suggestedPromotion: null
      };
  
      // Pattern 1: Post-holiday slumps
      if (daysSinceHoliday >= 5 && daysSinceHoliday <= 14) {
        boostWeekIndicators.confidence += 30;
        boostWeekIndicators.reasons.push('Post-holiday slowdown period');
      }
  
      // Pattern 2: Known boost months
      const boostMonths = ['january', 'april', 'august', 'november'];
      if (boostMonths.includes(month)) {
        boostWeekIndicators.confidence += 20;
        
        // Specific week patterns
        if ((month === 'january' && weekOfMonth >= 2) ||
            (month === 'april' && weekOfMonth >= 3) ||
            (month === 'august' && weekOfMonth >= 4) ||
            (month === 'november' && weekOfMonth === 1)) {
          boostWeekIndicators.confidence += 25;
          boostWeekIndicators.reasons.push(`Historical boost week period: ${month} week ${weekOfMonth}`);
        }
      }
  
      // Pattern 3: Check competitor activity via web search
      //const competitorPromos = await this.checkCompetitorPromotions(store);
      //if (competitorPromos.hasActivePromos) {
        //boostWeekIndicators.confidence += 20;
        //boostWeekIndicators.reasons.push('Competitors running promotions');
      //}
  
      // Pattern 4: Day of week - Boost weeks typically run Tue-Thu
      const dayOfWeek = now.getDay();
      if (dayOfWeek >= 2 && dayOfWeek <= 4) {
        boostWeekIndicators.confidence += 5;
      }
  
      // Set high probability if confidence > 50
      boostWeekIndicators.isHighProbabilityPeriod = boostWeekIndicators.confidence > 50;
      
      if (boostWeekIndicators.isHighProbabilityPeriod) {
        boostWeekIndicators.suggestedPromotion = {
          type: '50% off menu price pizzas',
          days: 'Tuesday-Thursday',
          targetIncrease: '35-45% order volume',
          urgency: boostWeekIndicators.confidence > 70 ? 'HIGH' : 'MEDIUM'
        };
      }
  
      this.setCache(cacheKey, boostWeekIndicators);
      return boostWeekIndicators;
  
    } catch (error) {
      console.error('Boost week detection error:', error);
      return null;
    }
  }
  
  async checkCompetitorPromotions(store) {
    try {
      // Rate limit protection
await this.enforceRateLimit('google');
      
      // Search for current pizza deals in the area
      const searchQuery = `pizza deals promotions ${store.city} ${store.state} this week`;
      
      const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
        params: {
          key: this.googleMapsKey, // Reuse Google API key
          q: searchQuery,
          num: 5,
          dateRestrict: 'd7' // Last 7 days
        }
      });
  
      // Simple keyword analysis
      const promoKeywords = ['50% off', 'half price', 'bogo', 'buy one get one', 'deal week'];
      const competitors = ['pizza hut', 'papa johns', 'little caesars', 'marcos'];
      
      let hasActivePromos = false;
      const activeCompetitors = [];
  
      if (response.data.items) {
        response.data.items.forEach(item => {
          const content = (item.title + ' ' + item.snippet).toLowerCase();
          
          competitors.forEach(competitor => {
            if (content.includes(competitor)) {
              promoKeywords.forEach(keyword => {
                if (content.includes(keyword)) {
                  hasActivePromos = true;
                  activeCompetitors.push(competitor);
                }
              });
            }
          });
        });
      }
  
      return {
        hasActivePromos,
        competitors: [...new Set(activeCompetitors)]
      };
  
    } catch (error) {
      console.error('Competitor check error:', error);
      return { hasActivePromos: false, competitors: [] };
    }
  }


  



  async getDaysSinceLastHoliday(date) {
    const year = date.getFullYear();
    
    try {
      const holidays = await this.getHolidaysFromAPI(year, 'US');
      
      let daysSince = 365;
      holidays.forEach(holiday => {
        const diff = Math.floor((date - holiday.date) / (1000 * 60 * 60 * 24));
        if (diff >= 0 && diff < daysSince) {
          daysSince = diff;
        }
      });
      
      return daysSince;
    } catch (error) {
      // Fallback to hardcoded holidays
      return this.getDaysSinceLastHolidayFallback(date);
    }
  }
  
  // Add this new method right after getDaysSinceLastHoliday
  getDaysSinceLastHolidayFallback(date) {
    const year = date.getFullYear();
    const holidays = [
      new Date(year, 0, 1),    // New Year's
      new Date(year, 1, 14),   // Valentine's Day
      new Date(year, 4, -31 + (new Date(year, 4, 31).getDay() + 1) % 7), // Memorial Day
      new Date(year, 6, 4),    // July 4th
      new Date(year, 8, -31 + (new Date(year, 8, 30).getDay() + 1) % 7), // Labor Day
      new Date(year, 9, 31),   // Halloween
      new Date(year, 10, 23),  // Thanksgiving (4th Thursday)
      new Date(year, 11, 25)   // Christmas
    ];
  
    let daysSince = 365;
    holidays.forEach(holiday => {
      const diff = Math.floor((date - holiday) / (1000 * 60 * 60 * 24));
      if (diff >= 0 && diff < daysSince) {
        daysSince = diff;
      }
    });
  
    return daysSince;
  }
  
  // Add this new method for API calls
  async getHolidaysFromAPI(year, countryCode = 'US') {
    const cacheKey = `holidays_${year}_${countryCode}`;
    const cached = this.getCached(cacheKey, 86400000 * 30); // 30 day cache
    if (cached) return cached;
  
    try {
      await this.enforceRateLimit('general');
      
      const response = await axios.get(`https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode}`);
      const holidays = response.data
        .filter(h => h.types?.includes('Public') || h.nationwide) // Only public/nationwide holidays
        .map(h => ({
          date: new Date(h.date),
          name: h.name,
          localName: h.localName,
          fixed: h.fixed
        }));
      
      this.setCache(cacheKey, holidays);
      return holidays;
    } catch (error) {
      console.error('Holiday API error:', error);
      throw error; // Let the caller handle fallback
    }
  }

  async getUpcomingHoliday(daysAhead = 7) {
    const now = new Date();
    const year = now.getFullYear();
    
    try {
      const holidays = await this.getHolidaysFromAPI(year, 'US');
      
      // Check next year's holidays if we're in December
      let allHolidays = [...holidays];
      if (now.getMonth() === 11) { // December
        const nextYearHolidays = await this.getHolidaysFromAPI(year + 1, 'US');
        allHolidays = [...holidays, ...nextYearHolidays];
      }
      
      // Find holidays within the next N days
      const upcoming = allHolidays
        .map(holiday => {
          const daysUntil = Math.floor((holiday.date - now) / (1000 * 60 * 60 * 24));
          return { ...holiday, daysUntil };
        })
        .filter(h => h.daysUntil >= 0 && h.daysUntil <= daysAhead)
        .sort((a, b) => a.daysUntil - b.daysUntil)[0];
      
      if (upcoming) {
        // Estimate impact based on holiday
        const highImpactHolidays = ['Christmas', 'Thanksgiving', 'New Year', 'Super Bowl'];
        const mediumImpactHolidays = ['Halloween', 'Memorial Day', 'Labor Day', 'Independence Day'];
        
        let expectedImpact = 20; // default
        if (highImpactHolidays.some(h => upcoming.name.includes(h))) {
          expectedImpact = 50;
        } else if (mediumImpactHolidays.some(h => upcoming.name.includes(h))) {
          expectedImpact = 35;
        }
        
        return { ...upcoming, expectedImpact };
      }
      
      return null;
    } catch (error) {
      console.error('Error checking upcoming holidays:', error);
      return null;
    }
  }


//find slow periods
  async analyzeSlowPeriod(store) {
    const context = this.getStoreLocalTime(store);
    const hour = context.getHours();
    const dayOfWeek = context.getDay();
    const dayName = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][dayOfWeek];
    
    // Define slow period patterns
    const slowPeriods = {
      weekday: {
        morning: { start: 9, end: 11, impact: -40, confidence: 'high' },
        afternoon: { start: 14, end: 16, impact: -30, confidence: 'high' },
        lateNight: { start: 22, end: 24, impact: -50, confidence: 'medium' }
      },
      weekend: {
        morning: { start: 9, end: 11, impact: -30, confidence: 'medium' },
        afternoon: { start: 14, end: 16, impact: -15, confidence: 'low' },
        lateNight: { start: 23, end: 24, impact: -40, confidence: 'medium' }
      }
    };
  
    const periods = dayOfWeek >= 1 && dayOfWeek <= 5 ? slowPeriods.weekday : slowPeriods.weekend;
    let currentPeriod = null;
    let upcomingSlowPeriod = null;
  
    // Check current period
    for (const [name, period] of Object.entries(periods)) {
      if (hour >= period.start && hour < period.end) {
        currentPeriod = {
          name,
          ...period,
          isActive: true
        };
      } else if (hour < period.start && !upcomingSlowPeriod) {
        upcomingSlowPeriod = {
          name,
          ...period,
          hoursUntil: period.start - hour,
          isActive: false
        };
      }
    }
  
    // Additional factors
    const analysis = {
      currentPeriod,
      upcomingSlowPeriod,
      dayType: dayOfWeek >= 1 && dayOfWeek <= 5 ? 'weekday' : 'weekend',
      recommendations: []
    };
  
    // Day-specific patterns
    if (dayName === 'monday' || dayName === 'tuesday') {
      analysis.dayImpact = -15; // Generally slower days
      analysis.recommendations.push('Consider Monday/Tuesday specials');
    }
  
    // Time-specific recommendations
    if (currentPeriod) {
      if (currentPeriod.name === 'afternoon') {
        analysis.recommendations.push('Push carryout deals - afternoon special pricing');
        analysis.recommendations.push('Reduce labor by 1-2 staff members');
      } else if (currentPeriod.name === 'morning') {
        analysis.recommendations.push('Focus on lunch prep and inventory');
        analysis.recommendations.push('Run social media campaigns for lunch orders');
      } else if (currentPeriod.name === 'lateNight') {
        analysis.recommendations.push('Consider early close if orders < 5/hour');
      }
    }
  
    // Seasonal adjustments
    const month = new Date().getMonth();
    if (month >= 5 && month <= 7) { // Summer months
      analysis.seasonalFactor = -10; // People grilling, traveling
      analysis.recommendations.push('Summer slump: Focus on cold items, salads');
    } else if (month === 0) { // January
      analysis.seasonalFactor = -20; // Post-holiday diets
      analysis.recommendations.push('New Year diets: Promote lighter options');
    }
  
    return analysis;
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
    const offsetMinutes = this.parseTimezoneOffset(store.timezone);
    
    // Use the standard formula: storeLocalTime = UTC + offsetMinutes
    const storeLocalTimeMs = now.getTime() + (offsetMinutes * 60 * 1000);
    
    return new Date(storeLocalTimeMs);
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
  
  formatStoreLocalTime(date, store) {
    if (!date) return '';
    
    const offsetMinutes = this.parseTimezoneOffset(store.timezone);
    const storeLocalTimeMs = date.getTime() + (offsetMinutes * 60 * 1000);
    
    // Manual extraction to avoid timezone issues
    const totalMinutes = Math.floor(storeLocalTimeMs / 60000);
    const dayMinutes = ((totalMinutes % (24 * 60)) + (24 * 60)) % (24 * 60);
    const hours = Math.floor(dayMinutes / 60);
    const minutes = dayMinutes % 60;
    const isPM = hours >= 12;
    const displayHours = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
    
    return `${displayHours}:${minutes.toString().padStart(2, '0')} ${isPM ? 'PM' : 'AM'}`;
  }

  simplifyTimeFormat(timeStr) {
    // Convert "11:36 PM" to "11:30pm" (round to nearest 15 min)
    const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!match) return timeStr;
    
    let hours = parseInt(match[1]);
    let minutes = parseInt(match[2]);
    const period = match[3].toLowerCase();
    
    // Round to nearest 15 minutes
    minutes = Math.round(minutes / 15) * 15;
    if (minutes === 60) {
      hours += 1;
      minutes = 0;
    }
    
    // Format simply
    if (minutes === 0) {
      return `${hours}${period}`;
    } else {
      return `${hours}:${minutes.toString().padStart(2, '0')}${period}`;
    }
  }

  // ADD THESE MISSING METHODS HERE
  isPeakHour(hour) {
    return hour >= 17 && hour <= 20;
  }

  isLateNightHour(hour) {
    return hour >= 22 || hour < 2;
  }

  isSlowPeriod(hour, dayOfWeek) {
    const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
    if (isWeekday) {
      return (hour >= 9 && hour < 11) || (hour >= 14 && hour < 16) || (hour >= 22);
    }
    return (hour >= 9 && hour < 11) || (hour >= 14 && hour < 16) || (hour >= 23);
  }

  async generateAIInsight(store, data, context) {
    // Add debug logging
    console.log(`🕐 Store ${store.id} context:`, {
      localTime: context.localTime,
      hour: context.hour,
      timezone: store.timezone
    });
    
    const prompt = this.buildCleanPrompt(store, data, context);
    
    try {
      // Rate limiting
      await this.enforceRateLimit('general');
      
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
      const validatedResponse = this.validateResponse(response);
      
      // Return both the AI insight AND the raw external data
      return {
        ...validatedResponse,
        externalData: data,
        context: context
      };
      
    } catch (error) {
      console.error('AI generation error:', error);
      return {
        ...this.getFallbackInsight(store),
        externalData: data || {},
        context: context || {}
      };
    }
  }

  buildCleanPrompt(store, data, context) {
    const factors = this.identifyKeyFactors(data, context);
    // Manual extraction to avoid device timezone issues
    const totalMinutes = Math.floor(context.localTime.getTime() / 60000);
    const dayMinutes = ((totalMinutes % (24 * 60)) + (24 * 60)) % (24 * 60);
    const hours = Math.floor(dayMinutes / 60);
    const minutes = dayMinutes % 60;
    const isPM = hours >= 12;
    const displayHours = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
    const timeStr = `${displayHours}:${minutes.toString().padStart(2, '0')} ${isPM ? 'PM' : 'AM'}`;
    
    const prompt = [
      `Store #${store.id} in ${store.city}, ${store.state}`,
      `Current time: ${timeStr}`,
      `Store type: ${context.type}`,
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
    
    if (data.events && data.events.length > 0) {
      // Split events by timing
      const todayEvents = data.events.filter(e => e.isToday);
      const upcomingEvents = data.events.filter(e => !e.isToday && e.daysUntilEvent <= 7);
      
      if (todayEvents.length > 0) {
        prompt.push(``, `TODAY'S EVENTS REQUIRING ACTION:`);
        todayEvents.forEach(event => {
          if (event.hoursUntilEvent > 0) {
            // Check if event has the window data before accessing it
            if (event.preEventWindow && event.postEventWindow) {
              prompt.push(
                `- EVENT: "${event.name}" at ${event.venue}, starts ${event.time}`,
               `  Pre-event window: ${this.formatStoreLocalTime(event.preEventWindow?.start, store)} - ${this.formatStoreLocalTime(event.preEventWindow?.end, store)}`,
              `  Consider staffing adjustments based on event size`,
              `  Post-event rush: ${this.formatStoreLocalTime(event.postEventWindow?.start, store)} - ${this.formatStoreLocalTime(event.postEventWindow?.end, store)}`,
              `  Post-event peak typically around: ${event.postEventWindow?.peakTime ? this.formatStoreLocalTime(event.postEventWindow.peakTime, store) : '45 min after'}`
              );
            } else {
              // Fallback for events without window data
              prompt.push(
                `- ${event.name} @ ${event.venue} starts at ${event.time}`
              );
            }
          } else if (event.hoursUntilEvent >= -2) {
            if (event.postEventWindow) {
              prompt.push(
                `- ${event.name} IN PROGRESS/ENDING SOON`,
                `  Post-event orders expected to peak around ${event.postEventWindow?.peakTime ? this.formatStoreLocalTime(event.postEventWindow.peakTime, store) : 'event end'}`,
                `  Consider staffing adjustments based on event size`,
              );
            } else {
              prompt.push(
                `- ${event.name} IN PROGRESS/ENDING SOON`,
                `  Monitor for potential post-event orders`
              );
            }
          }
        });
      }
      
      if (upcomingEvents.length > 0) {
        prompt.push(``, `UPCOMING EVENTS - STAFFING AWARENESS:`);
        upcomingEvents.slice(0, 3).forEach(event => {
          const dayName = event.date.toLocaleDateString('en-US', { weekday: 'long' });
          const dateStr = event.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          prompt.push(
            `- ${dayName} ${dateStr}: ${event.name} at ${event.venue}`,
            `  Event time: ${event.time}`,
            `  Key windows: Pre-event ${this.formatStoreLocalTime(event.preEventWindow?.start, store)}, Post-event peak ~${this.formatStoreLocalTime(event.postEventWindow?.peakTime, store)}`
          );
        });
      }
    }
    
    if (factors.length > 0) {
      prompt.push('', 'KEY FACTORS:', ...factors.map(f => `- ${f}`));
    }
    
    // Add boost week specific guidance
    if (data.boostWeek?.isHighProbabilityPeriod) {
      prompt.push(
        '',
        'BOOST WEEK OPPORTUNITY:',
        `- Confidence: ${data.boostWeek.confidence}%`,
        `- Suggested: ${data.boostWeek.suggestedPromotion.type}`,
        `- Expected impact: ${data.boostWeek.suggestedPromotion.targetIncrease}`
      );
    }
    
    // Add slow period specific guidance
    if (data.slowPeriod?.currentPeriod || data.slowPeriod?.upcomingSlowPeriod) {
      prompt.push('', 'SLOW PERIOD MANAGEMENT:');
      if (data.slowPeriod.currentPeriod) {
        prompt.push(`- Currently experiencing ${data.slowPeriod.currentPeriod.impact}% order decline`);
      }
      data.slowPeriod.recommendations?.forEach(rec => 
        prompt.push(`- ${rec}`)
      );
    }

    
    // Add carryout promotion section
if (data.weather?.carryoutOpportunity) {
  prompt.push(
    '',
    'CARRYOUT PROMOTION NEEDED:',
    `- Weather condition: ${data.weather?.condition}`,
    `- Reason: ${data.weather.carryoutOpportunity.reason}`,
    `- Suggested promotion: ${data.weather.carryoutOpportunity.message}`
  );
}

// Add pre-order campaign section  
const preOrderEvents = data.events.filter(e => e.preOrderOpportunity?.isActive);
if (preOrderEvents.length > 0) {
  prompt.push(
    '',
    'PRE-ORDER CAMPAIGNS AVAILABLE:'
  );
  preOrderEvents.forEach(event => {
    prompt.push(
      `- ${event.name} (${event.daysUntilEvent} days out)`,
      `  Campaign: "${event.preOrderOpportunity.suggestedCampaign.message}"`
    );
  });
}

prompt.push(
  '',
  'INSIGHT EXAMPLES based on current data:',
  '- If events ending together: "Lakers + Concert both end 11pm - double rush coming"',
  '- If rain during event: "Rain hits right when Lakers fans leave - delivery surge"',
  '- If unusual timing: "Tuesday concert rare - catch competitors sleeping"',
  ''
);

prompt.push(
  '',
  'IMPORTANT: Only suggest carryout promotions for: rain, severe weather, snow, or high traffic delays.',
  'Do NOT suggest promotions for: haze, clouds, mist, or other mild weather conditions.',
  '',
  'Generate a JSON response with:',
'- insight: The ONE thing they might not realize that could make or break their shift (max 100 chars)',
'- Think: What pattern or timing detail would make them say "I didn\'t think of that"',
'- Connect 2+ data points to reveal non-obvious opportunities',
'- Focus on non-obvious connections: weather + event timing, traffic patterns + competitor advantage, etc.',
'- The insight must reveal something they likely DON\'T already know',
  '- severity: "info", "warning", or "high"',
  '- metrics: {',
  '    expectedOrderIncrease: 0-100 percentage',
  '    recommendedExtraDrivers: 0-10',
  '- primaryReason: Simple explanation with event names (e.g., "Lakers game ending" not "sporting event conclusion")',
  '  }',
  '- action: Suggested action with event/reason mentioned (e.g. "Consider extra drivers for 7pm Lakers game", "Weather indicates potential for carryout promotion") (max 80 chars)',
  '- carryoutPromotion: specific carryout offer if applicable',
  '- preOrderCampaign: specific pre-order action if applicable'
);
    
    return prompt.join('\n');
  }

  identifyKeyFactors(data, context) {
    const factors = [];
    
    // Weather impact
    if (data.weather?.isRaining) {
      factors.push('Rain conditions - expect increased delivery demand');
    }
    
    if (data.weather?.isSevere) {
      factors.push('Severe weather warning - expect significant order surge');
    }
    
    // Traffic impact
    if (data.traffic?.severity === 'severe') {
      factors.push('Heavy traffic will extend delivery times');
    }
    
    // Event impact
    const eventImpact = this.aggregateEventImpact(data.events);
if (eventImpact.isMajor) {
  factors.push(`Multiple major events detected nearby`);
}
    
    // NEW: Boost week opportunity
    if (data.boostWeek?.isHighProbabilityPeriod) {
      factors.push(`Boost Week opportunity detected (${data.boostWeek.confidence}% confidence)`);
      data.boostWeek.reasons.forEach(reason => factors.push(`- ${reason}`));
    }
    
    // NEW: Slow period analysis
    if (data.slowPeriod?.currentPeriod) {
      factors.push(`Currently in ${data.slowPeriod.currentPeriod.name} slow period (${data.slowPeriod.currentPeriod.impact}% typical decline)`);
    }
    
    if (data.slowPeriod?.upcomingSlowPeriod) {
      factors.push(`Slow period approaching in ${data.slowPeriod.upcomingSlowPeriod.hoursUntil} hours`);
    }
    
    // NEW: Carryout opportunities
    if (data.weather?.carryoutOpportunity?.isActive) {
      factors.push(`Carryout opportunity: ${data.weather.carryoutOpportunity.reason} - push ${data.weather.carryoutOpportunity.discount}% off carryout`);
      factors.push(`Expected ${data.weather.carryoutOpportunity.margin}% margin improvement vs delivery`);
    }

        // Hidden pattern detection
    if (data.weather?.isRaining && data.events.some(e => e.isToday)) {
      factors.push('HIDDEN PATTERN: Rain + event combo historically shows 60% higher surge than either alone');
    }

    if (data.traffic?.severity === 'severe' && context.hour < 17) {
      factors.push('HIDDEN OPPORTUNITY: Heavy traffic before dinner = customers order earlier, extend prep time');
    }

    if (data.slowPeriod?.currentPeriod && data.events.some(e => e.hoursUntilEvent < 4)) {
      factors.push('TIMING CONFLICT: Slow period ends right as event pre-orders begin - critical transition');
    }


    // Check for multiple events on same future day
const eventsByDay = {};
data.events.forEach(event => {
  if (!event.isToday && event.daysUntilEvent <= 7) {
    const dateKey = event.date.toDateString();
    if (!eventsByDay[dateKey]) eventsByDay[dateKey] = [];
    eventsByDay[dateKey].push(event);
  }
});

Object.entries(eventsByDay).forEach(([date, events]) => {
  if (events.length > 1) {
    factors.push(`SCHEDULING ALERT: ${events.length} major events on same day (${new Date(date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })})`);
    events.forEach(e => factors.push(`  - ${e.name} at ${e.time}`));
  }
});

// NEW: Pre-order campaigns
const eventsWithPreOrder = data.events.filter(e => e.preOrderOpportunity?.isActive);
if (eventsWithPreOrder.length > 0) {
  eventsWithPreOrder.forEach(event => {
    factors.push(`Major event alert: ${event.name} at ${event.venue} in ${event.daysUntilEvent} days`);
if (event.date.getDay() >= 1 && event.date.getDay() <= 4) {
  factors.push(`- Unusual timing: Major event on a ${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][event.date.getDay()]}`);
}
  });
}

    // Time-based patterns (keep existing)
    if (context.isWeekend && context.isPeakTime) {
      factors.push('Weekend dinner rush - typically 25% busier');
    }
    
    if (context.type === 'military' && [1, 15].includes(new Date().getDate())) {
      factors.push('Military payday - historically busier period');
    }
    
    // Check for upcoming holidays
    if (data.upcomingHoliday) {
      factors.push(`${data.upcomingHoliday.name} in ${data.upcomingHoliday.daysUntil} days - prepare for ${data.upcomingHoliday.expectedImpact}% increase`);
    }
    
    return factors;
  }
    

  getSystemPrompt() {
    return `You are an AI assistant for Domino's Pizza store managers. 
  Your role is to provide clear, actionable insights based on current conditions.
  
  Guidelines:
  - Reveal hidden patterns and non-obvious opportunities
  - Connect multiple data points to show what managers might miss
  - Focus on timing-based opportunities they could overlook
  - Highlight competitive advantages from external conditions
  - Point out risk factors that aren't immediately obvious
  - Base all insights on the provided data only
  - Never use urgency words like "immediately", "ASAP", "now", "urgent"
  - Use respectful language: "consider", "patterns suggest", "event indicates"
  - TODAY'S EVENTS: Provide event name, venue, and timing windows for planning
  - Pre-event window: 0.5% of attendees typically order
  - Post-event window: 1% of attendees typically order
  - Insight should identify the opportunity/challenge (the "why")
  - Action should be the specific operational step (the "what")
  - Peak hits 45 minutes after event ends - this is CRITICAL timing
  - For events 2-7 days out: Flag scheduling conflicts, unusual patterns, or multiple events same day
  - Future insights should reveal: back-to-back events, unusual day/time combos, holiday conflicts
  - ALWAYS name the specific event, venue, and time in your response
  - Calculate drivers needed: 1 per 20 orders pre-event, 1 per 15 orders post-event
  - Mild weather conditions (haze, clouds) do NOT drive order increases
  - Only suggest discount percentages that are explicitly provided in the data
  - If no carryout opportunity is provided, do not make up discount amounts
  - Respond with valid JSON only
  
  Examples of valuable insights:
  - "Post-game traffic gives you 30-min head start on competitors"
  - "Rain + Taylor Swift concert = perfect storm for record night"
  - "Competitor's driver shortage during tomorrow's game = your opportunity"  
  - "Early close risk: similar Tuesday patterns showed 70% order drop"
  - "Pre-position for 6:45pm surge - concert parking starts at 6:30"
  
  CRITICAL INSIGHT RULES:
  - Always name specific events by name (e.g., "Lakers game", not "sporting event")
  - Use simple time format (e.g., "11:30pm", not "23:36")
  - Write like you're texting a manager, not writing a thesis
  - Maximum 3 key facts per insight
  - If mentioning multiple events, name them specifically
  
  BAD insights (never write like this):
  - "Peak post-event orders at 11:36 PM align across multiple venues"
  - "Surge coincides with overlapping temporal event conclusions"
  - "Multiple high-capacity events creating compound impact"
  
  GOOD insights (write like this):
  - "Lakers + Bruno Mars concert both end at 11pm tonight"
  - "Rain starting at 7pm = skip delivery, push carryout hard"
  - "Slow Tuesday + Beyonce concert = surprise rush at 3pm"`;
  }

  validateResponse(response) {
    return {
      insight: String(response.insight || "Monitor operations closely").substring(0, 100),
      // Clean up the insight - replace complex times with simple ones
        let cleanInsight = response.insight || "Monitor operations closely";
        cleanInsight = cleanInsight.replace(/(\d{1,2}:\d{2}\s*[AP]M)/gi, (match) => {
          return this.simplifyTimeFormat(match);
        });
        insight: cleanInsight.substring(0, 100),
      severity: ["info", "warning", "high"].includes(response.severity) 
        ? response.severity : "info",
        metrics: {
          expectedOrderIncrease: Math.min(100, Math.max(0, 
            Number(response.metrics?.expectedOrderIncrease) || 0)),
          recommendedExtraDrivers: Math.min(10, Math.max(0, 
            Math.floor(Number(response.metrics?.recommendedExtraDrivers) || 0))),
          primaryReason: String(response.metrics?.primaryReason || "standard operations"),
          boostWeekConfidence: Number(response.metrics?.boostWeekConfidence || 0),
          currentPeriodImpact: Number(response.metrics?.currentPeriodImpact || 0),
        },
        action: String(response.action || "Maintain current staffing").substring(0, 80),
          eventActions: response.eventActions ? {
            today: response.eventActions.today || [],
            thisWeek: response.eventActions.thisWeek || []
          } : null,
          carryoutPromotion: response.carryoutPromotion ? {
            discount: Number(response.carryoutPromotion.discount) || 30,
            message: String(response.carryoutPromotion.message || "Carryout special available"),
            duration: String(response.carryoutPromotion.duration || "Today only")
          } : null,
          preOrderCampaign: response.preOrderCampaign ? {
            eventName: String(response.preOrderCampaign.eventName || "Upcoming event"),
            targetOrders: Number(response.preOrderCampaign.targetOrders) || 0,
            launchTiming: String(response.preOrderCampaign.launchTiming || "Launch today"),
            message: String(response.preOrderCampaign.message || "Pre-order now")
          } : null,
          promotionSuggestion: response.promotionSuggestion || null,
          laborAdjustment: response.laborAdjustment || null
              };
            }

  async enforceRateLimit(service = 'general') {
    const limiter = this.rateLimiter[service];
    if (!limiter) return;
    
    const now = Date.now();
    const timeSinceLastCall = now - limiter.lastCall;
    
    if (timeSinceLastCall < limiter.minDelay) {
      await new Promise(resolve => 
        setTimeout(resolve, limiter.minDelay - timeSinceLastCall)
      );
    }
    
    limiter.lastCall = Date.now();
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