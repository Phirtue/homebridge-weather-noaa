import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { WeatherAccessory } from './weatherAccessory';
import { NOAAApi } from './noaaApi';

export class NOAAWeatherPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;
  private accessories: PlatformAccessory[] = [];
  private apiClient: NOAAApi;
  private weatherAccessory: WeatherAccessory;
  private lastTemp = 0;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.apiClient = new NOAAApi(config);
    this.api.on('didFinishLaunching', () => this.initialize());
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.accessories.push(accessory);
  }

  private async initialize() {
    const uuid = this.api.hap.uuid.generate('homebridge-noaa-weather-accessory');
    let accessory = this.accessories.find(acc => acc.UUID === uuid);

    if (!accessory) {
      accessory = new this.api.platformAccessory('NOAA Weather Sensor', uuid);
      this.api.registerPlatformAccessories('homebridge-weather-noaa', 'NOAAWeather', [accessory]);
    }

    this.weatherAccessory = new WeatherAccessory(this, accessory);
    this.startPolling();
  }

  private async startPolling() {
    await this.pollWeather();
  }

  private async pollWeather() {
    try {
      const data = await this.apiClient.getCurrentWeather();
      this.weatherAccessory.updateData(data);

      const diff = Math.abs(this.lastTemp - data.temperature);
      this.lastTemp = data.temperature;

      const nextInterval = diff < 0.5
        ? 30 * 60 * 1000
        : (this.config.pollInterval || 15) * 60 * 1000;

      this.log.info(`Weather updated: ${data.temperature}°C, ${data.humidity}% (next check in ${nextInterval / 60000} min)`);
      setTimeout(() => this.pollWeather(), nextInterval);
    } catch (err) {
      this.log.error('Error fetching NOAA weather:', err);
      setTimeout(() => this.pollWeather(), 15 * 60 * 1000);
    }
  }
}