import { 
  API, Logger, PlatformAccessory, PlatformConfig, DynamicPlatformPlugin 
} from 'homebridge';
import axios from 'axios';
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
        'User-Agent': 'homebridge-weather-noaa (your-email@example.com)',
        'Accept': 'application/geo+json'
      },
      timeout: 10000
    });

    api.on('didFinishLaunching', () => this.discoverDevices());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Cached accessory found (not used):', accessory.displayName);
  }

  async discoverDevices() {
    const latitude = this.config.latitude;
    const longitude = this.config.longitude;
    const refresh = (this.config.refreshInterval || 5) * 60 * 1000;

    if (!latitude || !longitude) {
      this.log.error('Latitude and Longitude must be configured.');
      return;
    }

    let stationId: string | null = null;

    // ✅ Allow manual override of station ID
    if (this.config.stationId) {
      this.log.info('Using manually configured NOAA station:', this.config.stationId);
      stationId = this.config.stationId;
    } else {
      try {
        const stations = await this.axiosInstance.get(
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
        this.log.info('Using closest NOAA station:', stationId);

      } catch (error) {
        this.log.error('Failed to fetch NOAA stations', error);
        return;
      }
    }

    const uuid = this.api.hap.uuid.generate('noaa-weather-unique');
    const accessory = new this.api.platformAccessory('NOAA Weather', uuid);
    const weatherAccessory = new NOAAWeatherAccessory(this, accessory);

    // ✅ Register internally (no child bridge)
    this.api.registerPlatformAccessories('homebridge-weather-noaa', 'NOAAWeather', [accessory]);

    const fetchWeather = async () => {
      try {
        const data = await this.axiosInstance.get(
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
