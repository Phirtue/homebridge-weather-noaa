import { 
  API, 
  Logger, 
  PlatformAccessory, 
  PlatformConfig, 
  DynamicPlatformPlugin 
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

  /**
   * Required for DynamicPlatformPlugin
   * Handles cached accessories restored from disk
   */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Cached accessory found (not used):', accessory.displayName);
  }

  /**
   * Discover devices and create our dynamic accessory
   */
  async discoverDevices() {
    const latitude = this.config.latitude;
    const longitude = this.config.longitude;
    const refresh = (this.config.refreshInterval || 15) * 60 * 1000;

    if (!latitude || !longitude) {
      this.log.error('Latitude and Longitude must be configured in plugin settings.');
      return;
    }

    let stationId: string | null = null;

    try {
      const stations = await axios.get(
        `https://api.weather.gov/points/${latitude},${longitude}/stations`
      );
      if (stations.data.features && stations.data.features.length > 0) {
        stationId = stations.data.features[0].properties.stationIdentifier;
        this.log.info('Using NOAA station:', stationId);
      } else {
        this.log.error('No NOAA stations found for the provided coordinates.');
        return;
      }
    } catch (error) {
      this.log.error('Failed to fetch NOAA stations', error);
      return;
    }

    const accessory = new this.api.platformAccessory('NOAA Weather', 'noaa-weather-uuid');
    const weatherAccessory = new NOAAWeatherAccessory(this, accessory);
    this.api.publishExternalAccessories('NOAAWeather', [accessory]);

    const fetchWeather = async () => {
      try {
        const data = await axios.get(
          `https://api.weather.gov/stations/${stationId}/observations/latest`
        );
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
