import { 
  API, Logger, PlatformAccessory, PlatformConfig, DynamicPlatformPlugin 
} from 'homebridge';
import axios from 'axios';
import { NOAAWeatherAccessory } from './weatherAccessory';

export class NOAAWeatherPlatform implements DynamicPlatformPlugin {

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.info('NOAAWeatherPlatform initialized');
    api.on('didFinishLaunching', () => this.discoverDevices());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Cached accessory found (not used):', accessory.displayName);
  }

  async discoverDevices() {
    const latitude = this.config.latitude;
    const longitude = this.config.longitude;
    const refresh = (this.config.refreshInterval || 15) * 60 * 1000;

    if (!latitude || !longitude) {
      this.log.error('Latitude and Longitude must be configured.');
      return;
    }

    let stationId: string | null = null;
    try {
      const stations = await axios.get(
        `https://api.weather.gov/points/${latitude},${longitude}/stations`
      );
      if (stations.data.features?.length > 0) {
        stationId = stations.data.features[0].properties.stationIdentifier;
        this.log.info('Using NOAA station:', stationId);
      } else {
        this.log.error('No NOAA stations found.');
        return;
      }
    } catch (error) {
      this.log.error('Failed to fetch NOAA stations', error);
      return;
    }

    const uuid = this.api.hap.uuid.generate('noaa-weather-unique');
    const accessory = new this.api.platformAccessory('NOAA Weather', uuid);
    const weatherAccessory = new NOAAWeatherAccessory(this, accessory);

    // ✅ FIX: register internally (no child bridge)
    this.api.registerPlatformAccessories('homebridge-weather-noaa', 'NOAAWeather', [accessory]);

    const fetchWeather = async () => {
      try {
        const data = await axios.get(
          `https://api.weather.gov/stations/${stationId}/observations/latest`
        );
        this.log.debug('NOAA Weather Data:', JSON.stringify(data.data.properties));
        accessory.context.weather = data.data.properties;
        weatherAccessory.updateValues();
      } catch (e) {
        this.log.error('Failed to fetch NOAA data', e);
      }
    };

    await fetchWeather();
    setInterval(fetchWeather, refresh);
  }
}
