const axios = require('axios');

class WeatherService {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.openweathermap.org/data/2.5';
  }

  async getWeatherByCity(city, state) {
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
      
      const weatherCondition = data.weather[0].main;
          const temp = Math.round(data.main.temp);
          const isRainy = ['Rain', 'Drizzle', 'Thunderstorm'].includes(weatherCondition);
          const isSnowy = ['Snow'].includes(weatherCondition);
          const isSevere = temp > 95 || temp < 35 || data.wind.speed > 25;

          // Calculate business impact
          let orderImpact = 0;
          let driverSafety = 'normal';
          let actionRequired = null;

          // Rain = 20-25% more orders
          if (isRainy) {
            orderImpact = 25;
            driverSafety = 'caution';
            actionRequired = 'Schedule extra drivers - expect 25% more orders';
          }

          // Snow = 30%+ more orders but slower delivery
          if (isSnowy) {
            orderImpact = 30;
            driverSafety = 'high-risk';
            actionRequired = 'Add 2-3 extra drivers, expect delays';
          }

          // Extreme temps = more orders
          if (temp > 90) {
            orderImpact = 15;
            actionRequired = 'Hot weather - ensure driver hydration';
          } else if (temp < 40) {
            orderImpact = 20;
            driverSafety = 'caution';
            actionRequired = 'Cold weather - expect 20% more orders';
          }

          // Use the new smart insight generator
return this.generateSmartInsight(data, null);
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
      this.getWeatherByCity(store.city, store.state || 'CA')
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
  generateSmartInsight(weatherData, storeData) {
    const temp = Math.round(weatherData.main.temp);
    const condition = weatherData.weather[0].main;
    const windSpeed = weatherData.wind.speed;
    const dayOfWeek = new Date().getDay();
    const hour = new Date().getHours();
    
    // Base patterns (these could come from a database of historical data)
    const patterns = {
      rain: { orderIncrease: 25, driverNeed: 2, peakShift: 1 },
      snow: { orderIncrease: 35, driverNeed: 3, peakShift: 2 },
      extreme_heat: { orderIncrease: 15, driverNeed: 1, peakShift: 0 },
      extreme_cold: { orderIncrease: 20, driverNeed: 1, peakShift: 1 },
      high_wind: { orderIncrease: 10, driverNeed: 1, peakShift: 0 }
    };
    
    let insight = null;
    let severity = 'info';
    let metrics = {};
    
    // Rain/Snow logic
    if (['Rain', 'Drizzle', 'Thunderstorm'].includes(condition)) {
      const pattern = patterns.rain;
      insight = `Rain starting around ${this.predictRainTime(weatherData)}. Expect busy dinner rush.`;
      severity = 'warning';
      metrics = {
        expectedOrderIncrease: pattern.orderIncrease,
        recommendedExtraDrivers: pattern.driverNeed,
        peakHours: '5-8 PM'
      };
    }
    else if (condition === 'Snow') {
      insight = `Snow conditions - customers order in but drivers move slowly. Staff up early.`;
      severity = 'critical';
      metrics = {
        expectedOrderIncrease: patterns.snow.orderIncrease,
        recommendedExtraDrivers: patterns.snow.driverNeed,
        peakHours: 'All day'
      };
    }
    // Temperature extremes
    else if (temp > 95) {
      insight = `Extreme heat - ensure driver hydration. AC seekers will order more.`;
      severity = 'warning';
      metrics = {
        expectedOrderIncrease: patterns.extreme_heat.orderIncrease,
        recommendedExtraDrivers: patterns.extreme_heat.driverNeed,
        peakHours: '12-3 PM'
      };
    }
    else if (temp < 35) {
      insight = `Freezing conditions - comfort food orders spike. Watch for icy roads.`;
      severity = temp < 25 ? 'critical' : 'warning';
      metrics = {
        expectedOrderIncrease: patterns.extreme_cold.orderIncrease,
        recommendedExtraDrivers: patterns.extreme_cold.driverNeed,
        peakHours: '6-9 PM'
      };
    }
    // High winds
    else if (windSpeed > 25) {
      insight = `High winds - secure driver top-signs. Possible delays.`;
      severity = 'warning';
      metrics = {
        expectedOrderIncrease: patterns.high_wind.orderIncrease,
        recommendedExtraDrivers: patterns.high_wind.driverNeed
      };
    }
    
    // Friday/Saturday adjustment
    if ((dayOfWeek === 5 || dayOfWeek === 6) && metrics.expectedOrderIncrease) {
      metrics.expectedOrderIncrease = Math.round(metrics.expectedOrderIncrease * 1.2);
      if (insight) insight += ' Weekend multiplier in effect.';
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
}

module.exports = WeatherService;