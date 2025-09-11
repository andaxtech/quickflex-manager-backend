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
      
      return {
        temperature: Math.round(data.main.temp),
        condition: data.weather[0].main,
        description: data.weather[0].description,
        high: Math.round(data.main.temp_max),
        low: Math.round(data.main.temp_min),
        humidity: data.main.humidity,
        windSpeed: Math.round(data.wind.speed),
        icon: data.weather[0].icon,
        // Check for severe weather conditions
        alert: this.checkForAlerts(data)
      };
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
}

module.exports = WeatherService;