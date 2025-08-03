import { 
  API, Logger, PlatformAccessory, PlatformConfig, DynamicPlatformPlugin 
} from 'homebridge';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { NOAAWeatherAccessory } from './weatherAccessory';

export class NOAAWeatherPlatform implements DynamicPlatformPlugin {
  private axiosInstance;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.info('NOAAWeatherPlatform initialized');

    // ✅ NOAA requires a User-Agent with contact info
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
    this.log.info('Cached accessory found (not used):', accessory.displayName);
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

    // ✅ Check for cached station
    if (!stationId && fs.existsSync(cacheFile)) {
      try {
        const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (
          cache.latitude === latitude &&
          cache.longitude === longitude &&
          (Date.now() - cache.timestamp) < 30 * 24 * 60 * 60 * 1000
        ) {
          this.log.info('Using cached NOAA station:', cache.stationId);
          stationId = cache.stationId;
        }
      } catch (e) {
        this.log.warn('Failed to read cache:', e);
      }
    }

    // ✅ Manual override or fresh fetch
    if (!stationId && !this.config.stationId) {
      try {
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

        // Sort stations by distance ascending
        stationList.sort((a: any, b: any) => a.distance - b.distance);

        // Log sorted stations
        this.log.warn(
          'NOAA stations sorted by distance:',
          stationList.map((s: any) => `${s.id} (${s.distance}m)`).join(', ')
        );

        // Pick the nearest station
        stationId = stationList[0].id;
        this.log.info('Fetched and selected closest NOAA station:', stationId);

        // ✅ Cache the station
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
      this.log.info('Using manually configured NOAA station:', this.config.stationId);
      stationId = this.config.stationId;
    }

    const uuid = this.api.hap.uuid.generate('noaa-weather-unique');
    const accessory = new this.api.platformAccessory('NOAA Weather', uuid);
    const weatherAccessory = new NOAAWeatherAccessory(this, accessory);

    // ✅ Register internally (no child bridge)
    this.api.registerPlatformAccessories('homebridge-weather-noaa', 'NOAAWeather', [accessory]);

    const fetchWeather = async () => {
      try {
        const data = await this.fetchWithRetry(
          `https://api.weather.gov/stations/${stationId}/observations/latest`
        );

        const properties = data.data.properties;
        this.log.debug('NOAA Weather Data:', JSON.stringify(properties));

        // ✅ Parse temperature & humidity
        accessory.context.weather = {
          temperature: properties.temperature?.value ?? null,
          humidity: properties.relativeHumidity?.value ?? null
        };

        weatherAccessory.updateValues();
      } catch (e) {
        this.log.error('Failed to fetch NOAA data', e);
      }
    };

    await fetchWeather();
    setInterval(fetchWeather, refresh);
  }
}
