import { API, Logger, PlatformAccessory, PlatformConfig, StaticPlatformPlugin } from 'homebridge';
import axios from 'axios';
import { NOAAWeatherAccessory } from './weatherAccessory';

export class NOAAWeatherPlatform implements StaticPlatformPlugin {
  private accessories: PlatformAccessory[] = [];
  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.info('NOAAWeatherPlatform initialized');
    api.on('didFinishLaunching', () => this.discoverDevices());
  }

  async discoverDevices() {
    const station = this.config.station;
    const refresh = (this.config.refreshInterval || 15) * 60 * 1000;

    const accessory = new this.api.platformAccessory('NOAA Weather', 'noaa-weather-uuid');
    new NOAAWeatherAccessory(this, accessory);
    this.api.publishExternalAccessories('NOAAWeather', [accessory]);

    setInterval(async () => {
      try {
        const data = await axios.get(`https://api.weather.gov/stations/${station}/observations/latest`);
        accessory.context.weather = data.data.properties;
        this.api.updatePlatformAccessories([accessory]);
      } catch (e) {
        this.log.error('Failed to fetch NOAA data', e);
      }
    }, refresh);
  }
}