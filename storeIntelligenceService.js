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
      lat: parseFloat(store.store_latitude || store.lat),
      lng: parseFloat(store.store_longitude || store.lng),
      timezone: store.timeZoneCode || store.time_zone_code || 'GMT-07:00',
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
    console.log(`\n📊 Collecting external data for store ${store.id}...`);
    
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
  
      const nowUTC = new Date();
const offsetMinutes = this.parseTimezoneOffset(store.timezone);
const storeNowMs = nowUTC.getTime() + (offsetMinutes * 60 * 1000);

// Calculate midnight today in store timezone
const totalMinutes = Math.floor(storeNowMs / 60000);
const dayMinutes = ((totalMinutes % (24 * 60)) + (24 * 60)) % (24 * 60);
const storeTodayStartMs = storeNowMs - (dayMinutes * 60000);
const storeTodayStart = new Date(storeTodayStartMs);

// Calculate 7 days from now in store's timezone
const storeWeekEnd = new Date(storeTodayStart);
storeWeekEnd.setDate(storeWeekEnd.getDate() + 7);
storeWeekEnd.setHours(23, 59, 59, 999);

// Convert back to UTC for API call (reuse offsetMinutes from above)
const startDateTimeUTC = new Date(storeTodayStart.getTime() - (offsetMinutes * 60 * 1000));
const endDateTimeUTC = new Date(storeWeekEnd.getTime() - (offsetMinutes * 60 * 1000));

const response = await axios.get('https://app.ticketmaster.com/discovery/v2/events.json', {
  params: {
    apikey: tmApiKey,
    latlong: `${store.lat},${store.lng}`,
    radius: '25',
    unit: 'miles',
    size: 20,  // Increased from 10
    sort: 'date,asc',
    startDateTime: startDateTimeUTC.toISOString().split('.')[0] + 'Z',
    endDateTime: endDateTimeUTC.toISOString().split('.')[0] + 'Z'
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
        // Only log essential info
      console.log(`  - ${event.name} | ${eventDate.toLocaleDateString()} | Venue: ${event._embedded?.venues?.[0]?.name || 'Unknown'}`);
      });

      const processedEvents = response.data._embedded.events
  .map(event => this.processEvent(event, store))
  .filter(event => event !== null); // Remove events that failed distance check

      // Log impact scores
      console.log('📊 Event impact scores:');
      processedEvents.forEach(e => {
        console.log(`  - ${e.name}: Impact ${e.impact.toFixed(2)}`);
      });

      const events = processedEvents
        .filter(event => {
          return event.impact >= 0.3 || event.isToday;
        })
        .slice(0, 10);

      console.log(`✅ Filtered to ${events.length} relevant events`);

      console.log('Ticketmaster date params:', {
        storeTimezone: store.timezone,
        startDateTimeUTC: startDateTimeUTC.toISOString(),
        endDateTimeUTC: endDateTimeUTC.toISOString()
      });

      // Debug event times
        // Summary log only
        console.log(`${logPrefix} ✅ Filtered to ${events.length} relevant events for today and upcoming`);

      this.setCache(cacheKey, events);
      return events;
      
    } catch (error) {
      if (error.response?.status === 429) {
        console.log('Ticketmaster rate limit hit - returning empty events');
        // Cache empty result for 5 minutes to avoid hitting rate limit
        this.setCache(cacheKey, [], 300000);
      } else {
        console.error(`Ticketmaster API error for store ${store.id}:`, error.message);
      }
      return [];
    }
  }

  async getEventData(store) {
    const cacheKey = `events_${store.id}`;
    const cached = this.getCached(cacheKey, 3600000); // 1 hour cache
    if (cached) return cached;

    const logPrefix = `[Store ${store.id}]`;
console.log(`\n${logPrefix} 🎪 Fetching events from multiple sources...`);

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

    const sources = {
      Ticketmaster: ticketmaster.status === 'fulfilled' ? ticketmaster.value.length : 0,
      SeatGeek: seatgeek.status === 'fulfilled' ? seatgeek.value.length : 0,
      Eventbrite: eventbrite.status === 'fulfilled' ? eventbrite.value.length : 0,
      GooglePlaces: googlePlaces.status === 'fulfilled' ? googlePlaces.value.length : 0
    };
    
    console.log(`${logPrefix} 📊 Events found:`, sources, `(Total: ${allEvents.length})`);

    // Deduplicate events
    const uniqueEvents = this.deduplicateEvents(allEvents);
    
    // Sort by date and filter
    const finalEvents = uniqueEvents
      .sort((a, b) => a.date - b.date)
      .filter(event => event.impact >= 0.2 || event.isToday) // Lowered threshold
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
        const eventDateUTC = new Date(event.datetime_utc);
          const nowUTC = new Date();

          // Calculate hours until event (both in UTC)
          const hoursUntilEvent = (eventDateUTC - nowUTC) / (1000 * 60 * 60);

          // Check if today in store timezone
          const offsetMinutes = this.parseTimezoneOffset(store.timezone);
          const nowMs = nowUTC.getTime();
          const storeNowMs = nowMs + (offsetMinutes * 60 * 1000);
          const storeToday = new Date(storeNowMs);
          storeToday.setHours(0, 0, 0, 0);
          const todayStartUTC = new Date(storeToday.getTime() - (offsetMinutes * 60 * 1000));
          const tomorrowStartUTC = new Date(todayStartUTC.getTime() + (24 * 60 * 60 * 1000));

          // Calculate if event is today in store timezone
          // Need to calculate storeTodayStartMs for this method
const totalMinutes = Math.floor(storeNowMs / 60000);
const dayMinutes = ((totalMinutes % (24 * 60)) + (24 * 60)) % (24 * 60);
const storeTodayStartMs = storeNowMs - (dayMinutes * 60000);

const eventStoreMs = eventDateUTC.getTime() + (offsetMinutes * 60 * 1000);
const isToday = eventStoreMs >= storeTodayStartMs && eventStoreMs < (storeTodayStartMs + 24 * 60 * 60 * 1000);
          const isPastToday = isToday && hoursUntilEvent < 0;

          // Format time in store's timezone (reuse eventStoreMs from above)
          const totalMinutesForTime = Math.floor(eventStoreMs / 60000);
          const dayMinutesForTime = ((totalMinutesForTime % (24 * 60)) + (24 * 60)) % (24 * 60);
          const hours = Math.floor(dayMinutesForTime / 60);
          const minutes = dayMinutesForTime % 60;
          const isPM = hours >= 12;
          const displayHours = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
          const timeStr = `${displayHours}:${minutes.toString().padStart(2, '0')} ${isPM ? 'PM' : 'AM'}`;
        
        return {
          name: event.title,
          venue: event.venue.name,
          date: eventDateUTC,
          dateUTC: eventDateUTC,
          time: timeStr,
          capacity: event.venue.capacity || 5000,
          type: event.type,
          impact: this.calculateEventImpact(event.venue.capacity || 5000, eventDateUTC),
          hoursUntilEvent,
          daysUntilEvent: Math.floor(hoursUntilEvent / 24),
          isToday,
          isPastToday: isToday && hoursUntilEvent < 0,
          source: 'seatgeek',
          preEventWindow: {
            start: new Date(eventDateUTC.getTime() - (3 * 60 * 60 * 1000)),
            end: new Date(eventDateUTC.getTime() - (30 * 60 * 1000)),
            expectedOrders: Math.floor((event.venue.capacity || 5000) * 0.005),
            staffingNeeded: Math.ceil(((event.venue.capacity || 5000) * 0.005) / 20)
          },
          postEventWindow: {
            start: eventDateUTC,
            end: new Date(eventDateUTC.getTime() + (2 * 60 * 60 * 1000)),
            peakTime: new Date(eventDateUTC.getTime() + (45 * 60 * 1000)),
            expectedOrders: Math.floor((event.venue.capacity || 5000) * 0.01),
            staffingNeeded: Math.ceil(((event.venue.capacity || 5000) * 0.01) / 15)
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
      // Skip if no Eventbrite credentials
      if (!process.env.EVENTBRITE_API_KEY && !process.env.EVENTBRITE_TOKEN && !process.env.EVENTBRITE_PUBLIC_TOKEN) {
        console.log('Eventbrite credentials not configured - skipping');
        return [];
      }
      
      const ebPublicToken = process.env.EVENTBRITE_PUBLIC_TOKEN || process.env.EVENTBRITE_TOKEN;
      const ebApiKey = process.env.EVENTBRITE_API_KEY;
      
      if (!ebPublicToken && !ebApiKey) {
        console.log('No Eventbrite credentials configured');
        return [];
      }
  
      const authHeader = ebApiKey 
        ? `Bearer ${ebApiKey}`
        : ebPublicToken 
          ? `Bearer ${ebPublicToken}`
          : null;

      if (!authHeader) {
        console.log('No valid Eventbrite credentials found');
        return [];
      }
  
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
            time: (() => {
              const offsetMinutes = this.parseTimezoneOffset(store.timezone);
              const eventStoreMs = eventDate.getTime() + (offsetMinutes * 60 * 1000);
              const eventStoreDate = new Date(eventStoreMs);
              const hours = eventStoreDate.getHours();
              const minutes = eventStoreDate.getMinutes();
              const isPM = hours >= 12;
              const displayHours = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
              return `${displayHours}:${minutes.toString().padStart(2, '0')} ${isPM ? 'PM' : 'AM'}`;
            })(),
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
        if (error.response?.status === 401) {
          console.log('Eventbrite authentication invalid - skipping');
        } else {
          console.error('Eventbrite API error:', error.message);
        }
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

  processEvent(event, store) {
    const venue = event._embedded?.venues?.[0];
    const capacity = parseInt(venue?.capacity) || 5000;
    
    // Validate venue distance
    if (venue?.location?.latitude && venue?.location?.longitude) {
      const distance = this.calculateDistance(
        store.lat,
        store.lng,
        parseFloat(venue.location.latitude),
        parseFloat(venue.location.longitude)
      );
      
      if (distance > 25) {
        console.log(`⚠️ Event "${event.name}" at ${venue.name} is ${distance.toFixed(1)} miles away - TOO FAR`);
        return null; // Will be filtered out
      }
    }
    
    // Add venue location to the processed event
    const venueLat = venue?.location?.latitude;
    const venueLng = venue?.location?.longitude;
    
    // Parse event date as UTC
      // Parse event date as UTC
const eventDateUTC = new Date(event.dates.start.dateTime);

// Get current UTC time (Date() already returns UTC internally)
const nowUTC = new Date();

// Calculate hours until event directly
const hoursUntilEvent = (eventDateUTC - nowUTC) / (1000 * 60 * 60);
const daysUntilEvent = Math.floor(hoursUntilEvent / 24);

// For "today" check, use store's timezone from database
const offsetMinutes = this.parseTimezoneOffset(store.timezone);

// Convert to store local time for "today" calculation
const storeNowMs = nowUTC.getTime() + (offsetMinutes * 60 * 1000);
// Calculate midnight today in store timezone
const totalMinutesStore = Math.floor(storeNowMs / 60000);
const dayMinutesStore = ((totalMinutesStore % (24 * 60)) + (24 * 60)) % (24 * 60);
const todayStartStoreMs = storeNowMs - (dayMinutesStore * 60000);
const tomorrowStartStoreMs = todayStartStoreMs + (24 * 60 * 60 * 1000);

// Convert event UTC to store local time
const eventStoreMs = eventDateUTC.getTime() + (offsetMinutes * 60 * 1000);

// Check if event is today in store's timezone
const isToday = eventStoreMs >= todayStartStoreMs && eventStoreMs < tomorrowStartStoreMs;
const isPastToday = isToday && hoursUntilEvent < 0;

// Format time in store's timezone
const totalMinutesEvent = Math.floor(eventStoreMs / 60000);
const dayMinutesEvent = ((totalMinutesEvent % (24 * 60)) + (24 * 60)) % (24 * 60);
const hours = Math.floor(dayMinutesEvent / 60);
const minutes = dayMinutesEvent % 60;
const isPM = hours >= 12;
const displayHours = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
const timeStr = `${displayHours}:${minutes.toString().padStart(2, '0')} ${isPM ? 'PM' : 'AM'}`;
    const eventData = {
      name: event.name,
      venue: venue?.name || 'Unknown',
      date: eventDateUTC, // Keep as UTC
      time: timeStr, // Display in store timezone
      capacity,
      type: event.classifications?.[0]?.segment?.name || 'Event',
      impact: this.calculateEventImpact(capacity, eventDateUTC),
      hoursUntilEvent,
      daysUntilEvent,
      isToday,
      isPastToday,
      
      // Pre/post windows in UTC
      preEventWindow: {
        start: new Date(eventDateUTC.getTime() - (3 * 60 * 60 * 1000)),
        end: new Date(eventDateUTC.getTime() - (30 * 60 * 1000)),
        expectedOrders: Math.floor(capacity * 0.005),
        staffingNeeded: Math.ceil((capacity * 0.005) / 20)
      },
      
      postEventWindow: {
        start: eventDateUTC,
        end: new Date(eventDateUTC.getTime() + (2 * 60 * 60 * 1000)),
        peakTime: new Date(eventDateUTC.getTime() + (45 * 60 * 1000)),
        expectedOrders: Math.floor(capacity * 0.01),
        staffingNeeded: Math.ceil((capacity * 0.01) / 15)
      }
    };
    
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
    
    // Capacity impact (adjusted for more realistic values)
    if (capacity >= 20000) impact += 0.6;
    else if (capacity >= 10000) impact += 0.4;
    else if (capacity >= 5000) impact += 0.2;
    else if (capacity >= 1000) impact += 0.1; // Added tier for smaller venues
    
    // Timing impact
    const hour = eventDate.getHours();
    if (hour >= 17 && hour <= 21) impact += 0.3; // Prime dinner time
    else if (hour >= 11 && hour <= 13) impact += 0.1; // Lunch time
    
    // Weekend impact
    const day = eventDate.getDay();
    if (day === 5 || day === 6) impact += 0.1;
    
    // Today bonus - events happening today are more relevant
    const now = new Date();
    const hoursUntilEvent = (eventDate - now) / (1000 * 60 * 60);
    if (hoursUntilEvent >= 0 && hoursUntilEvent <= 24) {
      impact += 0.2;
    }
    
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
    
    // Debug log
    console.log('Store timezone info:', {
      id: store.id,
      timezone: store.timezone,
      lat: store.lat,
      lng: store.lng
    });
    
    // Get current time in store's timezone
    const localTime = this.getStoreLocalTime(store);

    return {
      type: storeType.type,
      localTime: localTime.date,
      hour: localTime.hours,
      dayOfWeek: localTime.getDay(),
      isWeekend: localTime.getDay() === 0 || localTime.getDay() === 6,
      isPeakTime: this.isPeakHour(localTime.getHours()),
      isLateNight: this.isLateNightHour(localTime.getHours()),
      isSlowPeriod: this.isSlowPeriod(localTime.getHours(), localTime.getDay()),
      timezone: store.timezone
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
    const hour = context.hours;
    const dayOfWeek = context.dayOfWeek;
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
    try {
      // Step 1: Use Geocoding API to analyze address
      const geocodeData = await this.getGeocodeData(store);
      
      // Check for military/college keywords in address components
      if (this.hasAddressKeywords(geocodeData, ['base', 'fort', 'camp', 'naval', 'marine', 'afb'])) {
        return { type: 'military', subType: 'base' };
      }
      
      if (this.hasAddressKeywords(geocodeData, ['university', 'college', 'campus', 'student'])) {
        return { type: 'college', subType: 'campus' };
      }
      
      // Check for downtown indicators
      if (this.hasAddressKeywords(geocodeData, ['downtown', 'financial district', 'city center', 'central business'])) {
        return { type: 'downtown', subType: 'urban' };
      }
      
      // Step 2: Use Places API to verify with density check
      const placesData = await this.getPlacesDensityData(store);
      
      // High density of businesses indicates downtown
      if (placesData.businessDensity > 15 && placesData.avgRating > 4.0) {
        return { type: 'downtown', subType: 'urban' };
      }
      
      // Default to suburban
      return { type: 'suburban', subType: 'standard' };
      
    } catch (error) {
      console.error('Store classification error:', error);
      // Fallback to original simple logic
      return this.fallbackClassification(store);
    }
  }

  isNearLocation(store, locations) {
    return locations.some(loc => 
      this.calculateDistance(store.lat, store.lng, loc.lat, loc.lng) <= loc.radius
    );
  }

  async getGeocodeData(store) {
    const cacheKey = `geocode_${store.id}`;
    const cached = this.getCached(cacheKey, 86400000); // 24 hour cache
    if (cached) return cached;
    
    try {
      const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
        params: {
          latlng: `${store.lat},${store.lng}`,
          key: this.googleMapsKey
        }
      });
      
      const data = response.data.results[0];
      this.setCache(cacheKey, data);
      return data;
    } catch (error) {
      console.error('Geocoding API error:', error);
      return null;
    }
  }
  
  async getPlacesDensityData(store) {
    const cacheKey = `places_density_${store.id}`;
    const cached = this.getCached(cacheKey, 86400000); // 24 hour cache
    if (cached) return cached;
    
    try {
      const response = await axios.get('https://maps.googleapis.com/maps/api/place/nearbysearch/json', {
        params: {
          location: `${store.lat},${store.lng}`,
          radius: 500, // 500m radius
          type: 'establishment',
          key: this.googleMapsKey
        }
      });
      
      const places = response.data.results;
      const avgRating = places.reduce((sum, p) => sum + (p.rating || 0), 0) / places.length;
      
      const densityData = {
        businessDensity: places.length,
        avgRating: avgRating || 0,
        hasPointsOfInterest: places.some(p => p.types.includes('point_of_interest'))
      };
      
      this.setCache(cacheKey, densityData);
      return densityData;
    } catch (error) {
      console.error('Places API error:', error);
      return { businessDensity: 0, avgRating: 0 };
    }
  }
  
  hasAddressKeywords(geocodeData, keywords) {
    if (!geocodeData || !geocodeData.address_components) return false;
    
    const addressText = geocodeData.address_components
      .map(component => component.long_name.toLowerCase())
      .join(' ');
    
    return keywords.some(keyword => addressText.includes(keyword.toLowerCase()));
  }
  
  fallbackClassification(store) {
    // Original simple logic as backup
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


  getStoreLocalTime(store) {
    const offsetMinutes = this.parseTimezoneOffset(store.timezone);
    const now = new Date();
    const localMs = now.getTime() + (offsetMinutes * 60 * 1000);
    
    // Return an object with both the date and extracted components
    const totalMinutes = Math.floor(localMs / 60000);
    const dayMinutes = ((totalMinutes % (24 * 60)) + (24 * 60)) % (24 * 60);
    const hours = Math.floor(dayMinutes / 60);
    const minutes = dayMinutes % 60;
    
    return {
      date: new Date(localMs),
      ms: localMs,
      hours: hours,
      minutes: minutes,
      getHours: () => hours,
      getMinutes: () => minutes,
      getDay: () => new Date(localMs).getDay()
    };
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

  async saveClassification(storeId, classification, method = 'api_enhanced') {
    try {
      await this.dbPool.query(
        `UPDATE locations 
         SET metadata = COALESCE(metadata::jsonb, '{}'::jsonb) || $2::jsonb
         WHERE store_id = $1`,
        [storeId, JSON.stringify({
          store_type: classification.type,
          sub_type: classification.subType,
          classified_at: new Date().toISOString(),
          classification_method: method,
          classification_confidence: classification.confidence || null
        })]
      );
    } catch (error) {
      console.error('Error saving classification:', error);
    }
  }


  getStoreLocalDate(utcDate, store) {
    const offsetMinutes = this.parseTimezoneOffset(store.timezone);
    const localMs = utcDate.getTime() + (offsetMinutes * 60 * 1000);
    return new Date(localMs);
  }
  
  getStoreCurrentDate(store) {
    const now = new Date();
    return this.getStoreLocalDate(now, store);
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
    const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!match) return timeStr;
    
    let hours = parseInt(match[1]);
    let minutes = parseInt(match[2]);
    const period = match[3].toLowerCase();
    
    // Round to nearest 30 minutes for cleaner times
    if (minutes < 15) {
      minutes = 0;
    } else if (minutes < 45) {
      minutes = 30;
    } else {
      hours += 1;
      minutes = 0;
    }
    
    // Handle hour overflow
    if (hours > 12) {
      hours = hours - 12;
    } else if (hours === 0) {
      hours = 12;
    }
    
    // Format simply
    if (minutes === 0) {
      return `${hours}:00${period}`;
    } else {
      return `${hours}:30${period}`;
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
const systemPrompt = this.getSystemPrompt(context); // Pass context here

// DEBUG: Log the prompt being sent to AI
console.log(`🤖 AI Prompt for store ${store.id}:`);
      console.log(prompt);
      console.log('📊 Data summary:', {
        eventsCount: data.events?.length || 0,
        todayEvents: data.events?.filter(e => e.isToday).length || 0,
        upcomingEvents: data.events?.filter(e => !e.isToday && e.daysUntilEvent <= 7).length || 0,
        weather: data.weather?.condition,
        traffic: data.traffic?.severity,
        boostWeek: data.boostWeek?.isHighProbabilityPeriod
      });

      try {
        // Rate limiting
        await this.enforceRateLimit('general');
      
      //the AI generation process begins
      const completion = await this.openai.chat.completions.create({
        model: this.config.ai.model || 'gpt-4',
        messages: [
          {
            role: "system",
            content: systemPrompt // Use the context-aware prompt
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
console.log(`🎯 Raw AI Response for store ${store.id}:`, JSON.stringify(response, null, 2));

const validatedResponse = this.validateResponse(response, context);

// Return both the AI insight AND the raw external data
return {
  ...validatedResponse,
  externalData: data,
  context: context
};
      
    } catch (error) {
      console.error('AI generation error:', error);
      // Log more details about the error
      if (error.response) {
        console.error('API Error Response:', error.response.status, error.response.data);
      }
      console.error('Prompt that failed:', prompt.substring(0, 500) + '...');
      
      return {
        ...this.getFallbackInsight(store),
        externalData: data || {},
        context: context || {}
      };
    }
  }

  buildCleanPrompt(store, data, context) {
    const hour = context.hour;
    
    // Use time-specific prompt building
    if (hour >= 5 && hour < 10) {
      return this.buildMorningPrompt(store, data, context);
    } else if (hour >= 10 && hour < 14) {
      return this.buildLunchPrompt(store, data, context);
    } else if (hour >= 14 && hour < 17) {
      return this.buildAfternoonPrompt(store, data, context);
    } else if (hour >= 17 && hour < 22) {
      return this.buildEveningPrompt(store, data, context);
    } else {
      return this.buildLateNightPrompt(store, data, context);
    }
  }
  
  buildMorningPrompt(store, data, context) {
    const timeStr = this.formatTimeForPrompt(context);
    
    const prompt = [
      `Store #${store.id} in ${store.city}, ${store.state}`,
      `Current time: ${timeStr} - MORNING OPERATIONS`,
      `Day: ${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][context.dayOfWeek]}`,
      '',
      'MORNING CHECKLIST STATUS:'
    ];
    
    // Weather for delivery planning
    if (data.weather) {
      prompt.push(`- Weather for lunch: ${data.weather.temp}°F, ${data.weather.condition}`);
      if (data.weather.isRaining) {
        prompt.push(`  → Rainy lunch requires extra driver scheduling`);
      }
    }
    
    // Traffic patterns for lunch prep
    if (data.traffic) {
      prompt.push(`- Traffic conditions: ${data.traffic.severity} (affects lunch delivery planning)`);
    }
    
    // Check for lunch period events
    const lunchEvents = (data.events || []).filter(e => 
      e.hoursUntilEvent > 2 && e.hoursUntilEvent < 7 && !e.isPastToday
    );
    
    if (lunchEvents.length > 0) {
      prompt.push('', 'LUNCH PERIOD EVENTS:');
      lunchEvents.forEach(event => {
        prompt.push(
          `- ${event.name} at ${event.venue} (${event.time})`,
          `  → Prepare for ${event.postEventWindow.expectedOrders} additional orders`
        );
      });
    }
    
    // Pre-orders and catering
    const todayPreOrders = (data.events || []).filter(e => 
      e.isToday && e.preOrderOpportunity
    );
    
    if (todayPreOrders.length > 0) {
      prompt.push('', 'PRE-ORDERS/CATERING TODAY:');
      todayPreOrders.forEach(event => {
        prompt.push(`- ${event.capacity > 100 ? 'Large order' : 'Pre-order'} expected for ${event.name}`);
      });
    }
    
    // Inventory concerns from yesterday
    if (data.slowPeriod?.dayType === 'weekend' && context.dayOfWeek === 1) {
      prompt.push('', 'POST-WEEKEND NOTES:');
      prompt.push('- Check inventory levels after weekend volume');
      prompt.push('- Verify truck order accounts for weekend depletion');
    }
    
    return prompt.join('\n');
  }
  
  buildLunchPrompt(store, data, context) {
    const timeStr = this.formatTimeForPrompt(context);
    
    const prompt = [
      `Store #${store.id} - LUNCH OPERATIONS`,
      `Current time: ${timeStr}`,
      '',
      'CURRENT CONDITIONS:'
    ];
    
    // Weather impact on lunch
    if (data.weather) {
      prompt.push(`- Weather: ${data.weather.temp}°F, ${data.weather.condition}`);
      if (data.weather.isRaining) {
        prompt.push('  → Rain will increase delivery demand, reduce carryout');
      }
    }
    
    // Traffic for lunch deliveries
    if (data.traffic && data.traffic.affectsDelivery) {
      prompt.push(`- Traffic delays: ${data.traffic.delayMinutes} minutes`);
      prompt.push('  → Adjust promise times and driver count');
    }
    
    // Current/imminent events
    const lunchEvents = (data.events || []).filter(e => 
      e.hoursUntilEvent >= -1 && e.hoursUntilEvent <= 3
    );
    
    if (lunchEvents.length > 0) {
      prompt.push('', 'ACTIVE/IMMINENT EVENTS:');
      lunchEvents.forEach(event => {
        if (event.hoursUntilEvent <= 0) {
          prompt.push(`- ${event.name} happening NOW - expect surge`);
        } else {
          prompt.push(`- ${event.name} in ${Math.round(event.hoursUntilEvent)} hours`);
        }
      });
    }
    
    // Slow period considerations
    if (data.slowPeriod?.currentPeriod?.name === 'afternoon') {
      prompt.push('', 'AFTERNOON SLOW PERIOD:');
      prompt.push('- Consider carryout promotions');
      prompt.push('- Optimize labor allocation');
    }
    
    return prompt.join('\n');
  }
  
  buildAfternoonPrompt(store, data, context) {
    const timeStr = this.formatTimeForPrompt(context);
    
    const prompt = [
      `Store #${store.id} - AFTERNOON TRANSITION`,
      `Current time: ${timeStr}`,
      '',
      'DINNER PREP STATUS:'
    ];
    
    // Weather forecast for dinner
    if (data.weather) {
      prompt.push(`- Evening weather: ${data.weather.temp}°F, ${data.weather.condition}`);
      if (data.weather.isSevere) {
        prompt.push('  → Severe weather expected - prepare for major surge');
      }
    }
    
    // Evening events
    const dinnerEvents = (data.events || []).filter(e => 
      e.hoursUntilEvent > 2 && e.hoursUntilEvent <= 7
    );
    
    if (dinnerEvents.length > 0) {
      prompt.push('', 'DINNER PERIOD EVENTS:');
      dinnerEvents.forEach(event => {
        prompt.push(
          `- ${event.name} at ${event.time}`,
          `  → Expected ${event.postEventWindow.expectedOrders} orders post-event`,
          `  → Need ${event.postEventWindow.staffingNeeded} extra drivers`
        );
      });
    }
    
    // Boost week prep
    if (data.boostWeek?.isHighProbabilityPeriod) {
      prompt.push('', 'BOOST WEEK PREP:');
      prompt.push('- Ensure full topping levels');
      prompt.push('- Verify all drivers scheduled');
      prompt.push('- Prep team for high volume');
    }
    
    // Pre-order opportunities
    const futureEvents = (data.events || []).filter(e => 
      e.preOrderOpportunity?.isActive
    );
    
    if (futureEvents.length > 0) {
      prompt.push('', 'PRE-ORDER CAMPAIGNS:');
      futureEvents.slice(0, 2).forEach(event => {
        prompt.push(`- ${event.name}: Launch campaign now for ${event.daysUntilEvent} days out`);
      });
    }
    
    return prompt.join('\n');
  }
  
  buildEveningPrompt(store, data, context) {
    // Use existing evening logic but enhanced
    return this.buildStandardPrompt(store, data, context); // Reuse existing logic
  }
  
  buildLateNightPrompt(store, data, context) {
    const timeStr = this.formatTimeForPrompt(context);
    
    const prompt = [
      `Store #${store.id} - LATE NIGHT OPERATIONS`,
      `Current time: ${timeStr}`,
      '',
      'CLOSING CONSIDERATIONS:'
    ];
    
    // Late night events still affecting business
    const lateEvents = (data.events || []).filter(e => 
      e.isPastToday && e.hoursUntilEvent >= -2
    );
    
    if (lateEvents.length > 0) {
      prompt.push('- Post-event orders still coming from:');
      lateEvents.forEach(event => {
        prompt.push(`  → ${event.name} (ended ${Math.abs(Math.round(event.hoursUntilEvent))} hours ago)`);
      });
    }
    
    // Tomorrow prep
    const tomorrowEvents = (data.events || []).filter(e => 
      e.daysUntilEvent === 1
    );
    
    if (tomorrowEvents.length > 0) {
      prompt.push('', 'TOMORROW\'S EVENTS:');
      tomorrowEvents.forEach(event => {
        prompt.push(`- ${event.name} at ${event.time} - prep notes for opener`);
      });
    }
    
    // Weather for tomorrow's opening
    if (data.weather?.condition) {
      prompt.push('', 'TOMORROW\'S CONDITIONS:');
      prompt.push(`- Weather: ${data.weather.condition}`);
    }
    
    return prompt.join('\n');
  }
  
  buildStandardPrompt(store, data, context) {
    const factors = this.identifyKeyFactors(data, context);
    const timeStr = this.formatTimeForPrompt(context);
    
    const prompt = [
      `Store #${store.id} in ${store.city}, ${store.state}`,
      `Current time: ${timeStr}`,
      `Store type: ${context.type}`,
      '',
      'CURRENT CONDITIONS:'
    ];
  
    // Add weather data
    if (data.weather) {
      prompt.push(`- Weather: ${data.weather.temp}°F, ${data.weather.condition}`);
    }
    
    // Add traffic data
    if (data.traffic?.affectsDelivery) {
      prompt.push(`- Traffic: ${data.traffic.delayMinutes} min delays`);
    }
    
    // Add events data
    if (data.events && data.events.length > 0) {
      const todayEvents = data.events.filter(e => e.isToday);
      const upcomingEvents = data.events.filter(e => !e.isToday && e.daysUntilEvent <= 7);
      
      if (todayEvents.length > 0) {
        prompt.push('', 'TODAY\'S EVENTS:');
        todayEvents.forEach(event => {
          if (event.hoursUntilEvent > 0) {
            prompt.push(
              `- ${event.name} at ${event.venue} starts ${event.time}`,
              `  Expected orders: ${event.postEventWindow.expectedOrders}`,
              `  Peak time: ${this.formatStoreLocalTime(event.postEventWindow.peakTime, store)}`
            );
          } else if (event.hoursUntilEvent >= -2) {
            prompt.push(
              `- ${event.name} ENDING SOON`,
              `  Post-event surge expected around ${this.formatStoreLocalTime(event.postEventWindow.peakTime, store)}`
            );
          }
        });
      }
      
      if (upcomingEvents.length > 0) {
        prompt.push('', 'UPCOMING EVENTS:');
        upcomingEvents.slice(0, 3).forEach(event => {
          const dayName = event.date.toLocaleDateString('en-US', { weekday: 'long' });
          prompt.push(
            `- ${dayName}: ${event.name} at ${event.venue}`,
            `  Potential for ${event.postEventWindow.expectedOrders} pre-orders`
          );
        });
      }
    }
    
    // Add special opportunities
    if (data.boostWeek?.isHighProbabilityPeriod) {
      prompt.push(
        '',
        'BOOST WEEK OPPORTUNITY:',
        `- ${data.boostWeek.suggestedPromotion.type}`,
        `- Expected: ${data.boostWeek.suggestedPromotion.targetIncrease}`
      );
    }
    
    if (data.slowPeriod?.currentPeriod) {
      prompt.push(
        '',
        'SLOW PERIOD ACTIVE:',
        `- ${Math.abs(data.slowPeriod.currentPeriod.impact)}% below normal`,
        `- Recommendation: ${data.slowPeriod.recommendations[0]}`
      );
    }
    
    if (data.weather?.carryoutOpportunity) {
      prompt.push(
        '',
        'CARRYOUT OPPORTUNITY:',
        `- ${data.weather.carryoutOpportunity.message}`
      );
    }
    
    return prompt.join('\n');
  }
  
  formatTimeForPrompt(context) {
    const hours = context.hour;
    const minutes = context.minutes || 0;
    const isPM = hours >= 12;
    const displayHours = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
    return `${displayHours}:${minutes.toString().padStart(2, '0')} ${isPM ? 'PM' : 'AM'}`;
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
    

  getSystemPrompt(context) {
    const hour = context.hour;
    
    if (hour >= 5 && hour < 10) {
      return this.getMorningSystemPrompt(context);
    } else if (hour >= 10 && hour < 14) {
      return this.getLunchSystemPrompt(context);
    } else if (hour >= 14 && hour < 17) {
      return this.getAfternoonSystemPrompt(context);
    } else if (hour >= 17 && hour < 22) {
      return this.getEveningSystemPrompt(context);
    } else {
      return this.getLateNightSystemPrompt(context);
    }
  }
  
  getMorningSystemPrompt(context) {
    return `You are an experienced Domino's Pizza store manager conducting morning operations per SOP.
  
  Current priorities (5am-10am):
  - Manager arrival and security procedures
  - Cash control verification and till setup
  - Staff preparation and pre-shift huddle
  - Food prep: meats, veggies, sauces per PULSE labeling
  - System checks: PULSE terminals, make line refrigeration
  - Inventory assessment and truck order review
  
  You must respond in JSON format.Response format for MORNING:
  {
    "insight": "Focus on [specific opening task] because [reason]. [Weather/traffic impact on lunch prep]. [Any pre-orders or events affecting today].",
    "metrics": {
      "prepTasksComplete": percentage (0-100),
      "staffingReady": number of staff vs needed,
      "lunchReadiness": percentage,
      "preOrderCount": number,
      "inventoryStatus": "good/low/critical"
    },
    "action": "Primary task to complete by [time]",
    "severity": "info/warning/alert"
  }
  
  Example insights:
  - "Complete veggie prep by 9:30am - rainy lunch forecast needs extra drivers. 2 large catering orders at noon require early dough prep."
  - "Low on pepperoni (2 cases) - adjust truck order by 10am. Clear weather supports normal lunch staffing. No major events today."`;
  }
  
  getLunchSystemPrompt(context) {
    return `You are an experienced Domino's Pizza store manager managing lunch operations.
  
  Current priorities (10am-2pm):
  - Track Make Time (<2:30) and Service Time (<3:00)
  - Fair driver dispatch using zone/rotation
  - Manage breaks while maintaining coverage
  - Monitor topping hold times and temps
  - Prepare for afternoon transition
  
  You must respond in JSON format.Response format for LUNCH:
  {
    "insight": "[Current condition] affecting lunch - [action needed]. Expect [X]% ([Y] orders) vs normal. [Key metric] needs attention.",
    "metrics": {
      "currentMakeTime": seconds,
      "expectedOrderIncrease": percentage,
      "expectedOrderCount": number,
      "recommendedStaffAdjustment": number,
      "otdRisk": "low/medium/high"
    },
    "action": "Immediate action for service goals",
    "severity": "info/warning/alert"
  }`;
  }
  
  getAfternoonSystemPrompt(context) {
    return `You are an experienced Domino's Pizza store manager during afternoon transition.
  
  Current priorities (2pm-5pm):
  - Prep for dinner rush: top up all toppings
  - Review dinner staffing vs forecast
  - Coordinate driver schedules and breaks
  - Check inventory levels for evening
  - Address any lunch period issues
  
  You must respond in JSON format.Response format for AFTERNOON:
  {
    "insight": "[Prep status] for dinner rush. [Staffing or inventory concern]. [Event/weather impact] on evening demand.",
    "metrics": {
      "dinnerPrepComplete": percentage,
      "expectedDinnerVolume": percentage vs normal,
      "driverCountNeeded": number,
      "inventoryRisk": "none/low/high"
    },
    "action": "Critical prep task before 5pm",
    "severity": "info/warning/alert"
  }`;
  }
  
  getEveningSystemPrompt(context) {
    return `You are an experienced Domino's Pizza store manager during dinner rush.
  
  Current priorities (5pm-10pm):
  - Maintain OTD >85% and Make Time <2:30
  - Drive Time Captain managing dispatch
  - Monitor PULSE promise times vs capacity
  - Approve remakes for quality
  - Balance labor to demand
  
  You must respond in JSON format.Response format for EVENING:
  {
    "insight": "[Event/condition] at [time] - [staffing action] for [reason]. Expect [X]% ([Y] orders) increase. [Current metric status].",
    "metrics": {
      "expectedOrderIncrease": percentage,
      "expectedOrderCount": number,
      "recommendedExtraDrivers": number,
      "currentOTD": percentage,
      "laborPercent": percentage
    },
    "action": "Immediate staffing or operational change",
    "severity": "info/warning/alert"
  }`;
  }
  
  getLateNightSystemPrompt(context) {
    return `You are an experienced Domino's Pizza store manager during late night/close.
  
  Current priorities (10pm-close):
  - Balance service with closing tasks
  - Monitor labor % as volume decreases
  - Start breakdown per closing checklist
  - Ensure deposit and waste tracking
  - Prepare tomorrow's opening needs
  
  You must respond in JSON format.Response format for LATE NIGHT:
  {
    "insight": "[Current status] - begin [specific closing task]. [Tomorrow prep needed]. Labor at [X]% of sales.",
    "metrics": {
      "ordersPerHour": number,
      "laborPercent": percentage,
      "closingProgress": percentage,
      "tomorrowStaffingNeeds": number
    },
    "action": "Priority for efficient close",
    "severity": "info"
  }`;
  }

  validateResponse(response, context) {
    const hour = context?.hour || 12; // Default to noon if no context
    
    // Time-specific validation
    if (hour >= 5 && hour < 10) {
      return this.validateMorningResponse(response);
    } else if (hour >= 10 && hour < 14) {
      return this.validateLunchResponse(response);
    } else if (hour >= 14 && hour < 17) {
      return this.validateAfternoonResponse(response);
    } else {
      return this.validateStandardResponse(response); // Evening/late night use standard
    }
  }

  cleanInsightText(text) {
    // Remove any duplicate spaces and trim
    return text.replace(/\s+/g, ' ').trim();
  }

  
  validateMorningResponse(response) {
    return {
      insight: String(response.insight || "Complete opening procedures on schedule").substring(0, 200),
      severity: response.severity || "info",
      metrics: {
        prepTasksComplete: Number(response.metrics?.prepTasksComplete) || 0,
        staffingReady: Number(response.metrics?.staffingReady) || 0,
        lunchReadiness: Number(response.metrics?.lunchReadiness) || 0,
        preOrderCount: Number(response.metrics?.preOrderCount) || 0,
        inventoryStatus: String(response.metrics?.inventoryStatus || "good")
      },
      action: String(response.action || "Continue morning prep tasks").substring(0, 80)
    };
  }
  
  validateLunchResponse(response) {
    return {
      insight: this.cleanInsightText(response.insight || "Maintain lunch service standards"),
      severity: response.severity || "info",
      metrics: {
        currentMakeTime: Number(response.metrics?.currentMakeTime) || 150,
        expectedOrderIncrease: Number(response.metrics?.expectedOrderIncrease) || 0,
        expectedOrderCount: Number(response.metrics?.expectedOrderCount) || 0,
        recommendedStaffAdjustment: Number(response.metrics?.recommendedStaffAdjustment) || 0,
        otdRisk: String(response.metrics?.otdRisk || "low")
      },
      action: String(response.action || "Monitor service times").substring(0, 80)
    };
  }
  
  validateAfternoonResponse(response) {
    return {
      insight: this.cleanInsightText(response.insight || "Prepare for dinner rush"),
      severity: response.severity || "info",
      metrics: {
        dinnerPrepComplete: Number(response.metrics?.dinnerPrepComplete) || 0,
        expectedDinnerVolume: Number(response.metrics?.expectedDinnerVolume) || 100,
        driverCountNeeded: Number(response.metrics?.driverCountNeeded) || 0,
        inventoryRisk: String(response.metrics?.inventoryRisk || "none")
      },
      action: String(response.action || "Complete dinner prep").substring(0, 80)
    };
  }
  
  validateStandardResponse(response) {
    let cleanInsight = response.insight || "Monitor operations closely";
    
    // Ensure insight follows the expected pattern
    if (!cleanInsight.toLowerCase().includes('expect')) {
      // If AI didn't follow format, restructure it
      const orderIncrease = response.metrics?.expectedOrderIncrease || 0;
      const orderCount = response.metrics?.expectedOrderCount || Math.floor(orderIncrease * 3);
      cleanInsight = cleanInsight + `. Expect ${orderIncrease}% (${orderCount} order) change.`;
    }
    
    // First, replace specific times with rounded versions
    cleanInsight = cleanInsight.replace(/(\d{1,2}):(\d{2})\s*(AM|PM)/gi, (match, hours, minutes, period) => {
      const h = parseInt(hours);
      const m = parseInt(minutes);
      
      // Round to nearest 15 minutes
      const roundedMinutes = Math.round(m / 15) * 15;
      
      // For times near the top of the hour, use natural language
      if (h === 12 && roundedMinutes === 0) {
        return "noon";
      } else if (roundedMinutes === 0) {
        return `${h}${period.toLowerCase()}`;
      } else if (roundedMinutes === 60) {
        return `${h + 1}${period.toLowerCase()}`;
      } else {
        return `${h}:${roundedMinutes.toString().padStart(2, '0')}${period.toLowerCase()}`;
      }
    });
    
    // Then apply the existing simplification
    cleanInsight = cleanInsight.replace(/(\d{1,2}:\d{2}\s*[ap]m)/gi, (match) => {
      return this.simplifyTimeFormat(match);
    });
    
    return {
      insight: cleanInsight.substring(0, 200),
      severity: "info",
      metrics: {
        expectedOrderIncrease: Math.min(100, Math.max(0, 
          Number(response.metrics?.expectedOrderIncrease) || 0)),
        expectedOrderCount: Number(response.metrics?.expectedOrderCount) || 
          Math.floor((response.metrics?.expectedOrderIncrease || 0) * 3),
        recommendedExtraDrivers: Math.min(10, Math.max(0, 
          Math.floor(Number(response.metrics?.recommendedExtraDrivers) || 0))),
        confidence: response.metrics?.confidence || "medium"
      },
      action: String(response.action || "Monitor orders and adjust as needed").substring(0, 80),
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
      } : null
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
      insight: "Normal conditions - maintain standard operations. Expect 0% (0 orders) change. All systems normal.",
      severity: "info",
      metrics: {
        expectedOrderIncrease: 0,
        expectedOrderCount: 0,
        recommendedExtraDrivers: 0,
        confidence: "high"
      },
      action: "Monitor orders and adjust as needed",
      carryoutPromotion: null,
      preOrderCampaign: null
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