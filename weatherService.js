const axios = require('axios');
const OpenAI = require('openai');

class WeatherService {
  constructor(apiKey, openAIKey) {
    this.apiKey = apiKey;
    this.openAIKey = openAIKey;
    this.baseUrl = 'https://api.openweathermap.org/data/2.5';
    
    if (this.openAIKey) {
      this.openai = new OpenAI({
        apiKey: this.openAIKey
      });
    }
  }

  async getWeatherByCity(city, state, storeData = null) {
    try {
      // Format location for API (e.g., "Calabasas,CA,US")
      const location = `${city},${state},US`;
      
      const response = await axios.get(`${this.baseUrl}/weather`, {
        params: {
          q: location,
          appid: this.apiKey,
          units: 'imperial' // For Fahrenheit
        }
      });

      const data = response.data;

          // Use the new smart insight generator (now async)
          return await this.generateSmartInsight(data, storeData);
    } catch (error) {
      console.error(`Weather API error for ${city}, ${state}:`, error.message);
      return null;
    }
  }

  async getWeatherByCoordinates(lat, lon) {
    try {
      const response = await axios.get(`${this.baseUrl}/weather`, {
        params: {
          lat,
          lon,
          appid: this.apiKey,
          units: 'imperial'
        }
      });

      const data = response.data;
      
      return {
        temperature: Math.round(data.main.temp),
        condition: data.weather[0].main,
        description: data.weather[0].description,
        high: Math.round(data.main.temp_max),
        low: Math.round(data.main.temp_min),
        humidity: data.main.humidity,
        windSpeed: Math.round(data.wind.speed),
        icon: data.weather[0].icon,
        alert: this.checkForAlerts(data)
      };
    } catch (error) {
      console.error('Weather API error:', error.message);
      return null;
    }
  }

  checkForAlerts(weatherData) {
    const temp = weatherData.main.temp;
    const windSpeed = weatherData.wind.speed;
    const weatherId = weatherData.weather[0].id;

    // Temperature alerts
    if (temp > 100) return 'Extreme Heat Warning';
    if (temp < 32) return 'Freezing Conditions';
    
    // Wind alerts
    if (windSpeed > 25) return 'High Wind Advisory';
    
    // Weather condition alerts (based on OpenWeather condition codes)
    if (weatherId >= 200 && weatherId < 300) return 'Thunderstorm Warning';
    if (weatherId >= 502 && weatherId < 600) return 'Heavy Rain Warning';
    if (weatherId >= 600 && weatherId < 700) return 'Snow Alert';
    
    return undefined;
  }

  // Batch fetch for multiple locations (more efficient)
  async getWeatherForStores(stores) {
    const weatherPromises = stores.map(store => 
      this.getWeatherByCity(store.city, store.state || 'CA', store)
        .then(weather => ({ storeId: store.store_id, weather }))
    );

    const results = await Promise.all(weatherPromises);
    
    // Convert to a map for easy lookup
    const weatherMap = {};
    results.forEach(result => {
      weatherMap[result.storeId] = result.weather;
    });

    return weatherMap;
  }
  getBusinessAlert(weatherData) {
    const temp = weatherData.main.temp;
    const condition = weatherData.weather[0].main;
    
    // Priority alerts for managers
    if (['Rain', 'Drizzle', 'Thunderstorm'].includes(condition)) {
      return '🌧️ +25% orders expected';
    }
    if (condition === 'Snow') {
      return '🌨️ +30% orders, add drivers';
    }
    if (temp > 95) {
      return '🔥 Extreme heat - hydration breaks';
    }
    if (temp < 32) {
      return '❄️ Freezing - drive carefully';
    }
    if (weatherData.wind.speed > 25) {
      return '💨 High winds - secure items';
    }
    
    return null;
  }
  async generateSmartInsight(weatherData, storeData) {
    const temp = Math.round(weatherData.main.temp);
    const condition = weatherData.weather[0].main;
    
    // Simple, actionable metrics only
    let metrics = null;
    
    if (['Rain', 'Drizzle', 'Thunderstorm'].includes(condition)) {
      metrics = {
        expectedOrderIncrease: 25,
        recommendedExtraDrivers: 2,
        peakHours: '5-8 PM'
      };
    } else if (condition === 'Snow') {
      metrics = {
        expectedOrderIncrease: 35,
        recommendedExtraDrivers: 3,
        peakHours: 'All day'
      };
    } else if (temp > 95) {
      metrics = {
        expectedOrderIncrease: 15,
        recommendedExtraDrivers: 1,
        peakHours: '12-3 PM'
      };
    }
    
    return {
      temperature: temp,
      condition: condition,
      icon: weatherData.weather[0].icon,
      metrics: metrics || {}
    };
  }

// Handle normal conditions with positive messaging
if (!insight) {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const currentDay = dayNames[dayOfWeek];
  
  if (temp >= 65 && temp <= 80 && !['Rain', 'Snow', 'Thunderstorm'].includes(condition)) {
    insight = `Perfect ${temp}°F - expect steady ${currentDay} business. Great day for driver retention!`;
    severity = 'info';
  } else if (temp >= 50 && temp < 65) {
    insight = `Mild ${temp}°F - typical ${currentDay} patterns. Good conditions for on-time delivery.`;
    severity = 'info';
  } else if (temp > 80 && temp <= 95) {
    insight = `Warm ${temp}°F - stay hydrated. ${currentDay} dinner rush should be normal.`;
    severity = 'info';
  } else {
    insight = `${temp}°F with ${condition.toLowerCase()}. Standard ${currentDay} operations expected.`;
    severity = 'info';
  }
  
  // Add day-specific insights
  if (dayOfWeek === 0) insight += ' Sunday family orders peak 5-7 PM.';
  if (dayOfWeek === 5) insight += ' Friday night rush starts early!';
  if (dayOfWeek === 1) insight += ' Mondays are 15% slower on average.';
}
    
    return {
      temperature: temp,
      condition: condition,
      icon: weatherData.weather[0].icon,
      insight: insight,
      severity: severity,
      metrics: metrics
    };
  }
  
  predictRainTime(weatherData) {
    // This could be enhanced with real forecast data
    const currentHour = new Date().getHours();
    if (currentHour < 12) return '2-3 PM';
    if (currentHour < 17) return '5-6 PM';
    return 'next 2 hours';
  }

  async generateAIInsight(weatherData, storeData) {
    const temp = Math.round(weatherData.main.temp);
    const condition = weatherData.weather[0].main;
    const windSpeed = Math.round(weatherData.wind.speed);
    // Calculate store's local time for AI prompt
const now = new Date();
const storeOffset = this.getStoreOffset(storeData); // in minutes
const storeLocalTime = new Date(now.getTime() + (storeOffset * 60000));
const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayOfWeek = dayNames[storeLocalTime.getUTCDay()];
const hour = storeLocalTime.getUTCHours();
    
    const prompt = `As a pizza delivery operations assistant, provide a brief, actionable insight for a store manager.

Current conditions:
- Temperature: ${temp}°F
- Weather: ${condition}
- Wind: ${windSpeed} mph
- Day: ${dayOfWeek}
- Hour: ${hour}:00 (24-hour format)
${storeData ? `- Store: ${storeData.city}, ${storeData.state}
- Current open shifts: ${storeData.shifts?.open || 'unknown'}
- Current booked shifts: ${storeData.shifts?.booked || 'unknown'}` : ''}

Provide a JSON response with:
1. "insight": One positive, actionable sentence (max 100 chars)
2. "severity": "info", "warning", or "critical"
3. "metrics": {
     "expectedOrderIncrease": percentage (0 if normal),
     "recommendedExtraDrivers": number (0 if none),
     "peakHours": string (e.g., "5-8 PM") or null
   }

Focus on: staffing decisions, order volume expectations, delivery conditions, and opportunities.
Frame normal weather positively. Example: "Perfect 72°F Tuesday - great for driver retention!"`;

    try {
      const completion = await this.openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
        max_tokens: 200,
        response_format: { type: "json_object" }
      });

      const response = JSON.parse(completion.choices[0].message.content);
      
      return {
        temperature: temp,
        condition: condition,
        icon: weatherData.weather[0].icon,
        insight: response.insight,
        severity: response.severity || 'info',
        metrics: response.metrics || {}
      };
    } catch (error) {
      console.error('OpenAI API error:', error);
      return null; // Will fallback to rule-based system
    }
  }

  getStoreOffset(storeData) {
    // Default to PST if no store data
    if (!storeData || !storeData.timeZoneCode) return -480; // PST = GMT-08:00
    
    const match = storeData.timeZoneCode.match(/GMT([+-])(\d{2}):(\d{2})/);
    if (!match) return -480; // Default to PST
    
    const sign = match[1] === '+' ? 1 : -1;
    const hours = parseInt(match[2], 10);
    const mins = parseInt(match[3], 10);
    return sign * (hours * 60 + mins);
  }
}

module.exports = WeatherService;