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
    const latitude = this.config.latitude;
    const longitude = this.config.longitude;
    const refresh = (this.config.refreshInterval || 15) * 60 * 1000;

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
    new NOAAWeatherAccessory(this, accessory);
    this.api.publishExternalAccessories('NOAAWeather', [accessory]);

    const fetchWeather = async () => {
      try {
        const data = await axios.get(
          `https://api.weather.gov/stations/${stationId}/observations/latest`
        );
        accessory.context.weather = data.data.properties;
        this.api.updatePlatformAccessories([accessory]);
      } catch (e) {
        this.log.error('Failed to fetch NOAA data', e);
      }
    };

    await fetchWeather();
    setInterval(fetchWeather, refresh);
  }
}