import { 
  API, Logger, PlatformAccessory, PlatformConfig, DynamicPlatformPlugin 
} from 'homebridge';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { NOAAWeatherAccessory } from './weatherAccessory';

export class NOAAWeatherPlatform implements DynamicPlatformPlugin {
  private axiosInstance;
  private accessories: PlatformAccessory[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.info('NOAAWeatherPlatform initialized');

    this.axiosInstance = axios.create({
      headers: {
        'User-Agent': 'homebridge-weather-noaa (https://github.com/Phirtue/homebridge-weather-noaa/)',
        'Accept': 'application/geo+json',
        'Referer': 'https://github.com/Phirtue/homebridge-weather-noaa'
      },
      timeout: 10000
    });

    api.on('didFinishLaunching', () => this.discoverDevices());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Re-using cached accessory:', accessory.displayName);
    this.accessories.push(accessory);
  }

  private async fetchWithRetry(url: string, maxRetries = 4): Promise<any> {
    let attempt = 0;
    let delay = 1000;

    while (attempt < maxRetries) {
      try {
        const response = await this.axiosInstance.get(url);
        return response;
      } catch (error: any) {
        const status = error.response?.status || 'NO_RESPONSE';
        if ([500, 502, 503, 504].includes(status) || status === 'NO_RESPONSE') {
          this.log.warn(`Request failed (status: ${status}). Retrying in ${delay / 1000}s...`);
          await new Promise(res => setTimeout(res, delay));
          delay *= 2;
          attempt++;
        } else {
          throw error;
        }
      }
    }
    throw new Error(`Failed after ${maxRetries} attempts for URL: ${url}`);
  }

  async discoverDevices() {
    const latitude = this.config.latitude;
    const longitude = this.config.longitude;
    const refresh = (this.config.refreshInterval || 5) * 60 * 1000;
    const cacheFile = path.join(this.api.user.persistPath(), 'noaa-points-cache.json');

    if (!latitude || !longitude) {
      this.log.error('Latitude and Longitude must be configured.');
      return;
    }

    let stationId: string | null = this.config.stationId || null;

    if (!stationId && fs.existsSync(cacheFile)) {
      try {
        const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (
          cache.latitude === latitude &&
          cache.longitude === longitude &&
          (Date.now() - cache.timestamp) < 30 * 24 * 60 * 60 * 1000
        ) {
          this.log.info('📦 Using cached NOAA station:', cache.stationId);
          stationId = cache.stationId;
        }
      } catch (e) {
        this.log.warn('Failed to read cache:', e);
      }
    }

    if (!stationId && !this.config.stationId) {
      try {
        this.log.info('🔎 Fetching NOAA stations for coordinates:', latitude, longitude);
        const stations = await this.fetchWithRetry(
          `https://api.weather.gov/points/${latitude},${longitude}/stations`
        );

        const stationList = stations.data.features
          .filter((f: any) => /^[A-Z0-9]{3,4}$/.test(f.properties.stationIdentifier))
          .map((f: any) => ({
            id: f.properties.stationIdentifier,
            distance: f.properties.distance?.value ?? Number.MAX_SAFE_INTEGER
          }));

        if (stationList.length === 0) {
          this.log.error('No valid NOAA stations found.');
          return;
        }

        stationList.sort((a: any, b: any) => a.distance - b.distance);

        this.log.info(
          '📡 NOAA stations sorted by distance:',
          stationList.map((s: any) => `${s.id} (${s.distance}m)`).join(', ')
        );

        stationId = stationList[0].id;
        this.log.info('✅ Selected closest NOAA station:', stationId);

        fs.writeFileSync(cacheFile, JSON.stringify({
          latitude,
          longitude,
          stationId,
          timestamp: Date.now()
        }, null, 2));
      } catch (error) {
        this.log.error('Failed to fetch NOAA stations', error);
        return;
      }
    } else if (this.config.stationId) {
      this.log.info('📍 Using manually configured NOAA station:', this.config.stationId);
      stationId = this.config.stationId;
    }

    const uuid = this.api.hap.uuid.generate('noaa-weather-unique');
    let accessory = this.accessories.find(acc => acc.UUID === uuid);

    if (accessory) {
      this.log.info('Reusing existing accessory for NOAA Weather.');
    } else {
      accessory = new this.api.platformAccessory('NOAA Weather', uuid);
      this.api.registerPlatformAccessories('homebridge-weather-noaa', 'NOAAWeather', [accessory]);
      this.log.info('Created new accessory for NOAA Weather.');
    }

    const weatherAccessory = new NOAAWeatherAccessory(this, accessory);

    const fetchWeather = async () => {
      this.log.info('🔄 Starting NOAA weather update...');
      try {
        const data = await this.fetchWithRetry(
          `https://api.weather.gov/stations/${stationId}/observations/latest`
        );

        const properties = data.data.properties;
        const timestamp = properties.timestamp;
        const temperature = properties.temperature?.value;
        const humidity = properties.relativeHumidity?.value;
        const tempQC = properties.temperature?.qualityControl;
        const humidityQC = properties.relativeHumidity?.qualityControl;
        const elevation = properties.elevation?.value;
        const weatherConditions = properties.presentWeather?.map((w: any) => w.weather).join(', ') || 'None';

        this.log.info(
          `🌡️ NOAA Data — Timestamp: ${timestamp}, ` +
          `Temp: ${temperature}°C (QC: ${tempQC}), ` +
          `Humidity: ${humidity}% (QC: ${humidityQC}), ` +
          `Elevation: ${elevation}m, ` +
          `Conditions: ${weatherConditions}`
        );

        accessory.context.weather = { temperature, humidity };
        weatherAccessory.updateValues();
      } catch (e) {
        this.log.error('❌ Failed to fetch NOAA data', e);
      }
    };

    await fetchWeather();
    setInterval(fetchWeather, refresh);
  }
}
