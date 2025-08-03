import { Service, PlatformAccessory } from 'homebridge';
import fs from 'fs';
import path from 'path';
import { NOAAWeatherPlatform } from './platform';

export class NOAAWeatherAccessory {
  private temperatureService: Service;
  private humidityService: Service;
  private cacheFile: string;
  private lastTemperature: number | null = null;
  private lastHumidity: number | null = null;

  constructor(
    private readonly platform: NOAAWeatherPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const persistPath = this.platform.api.user.persistPath();
    this.cacheFile = path.join(persistPath, 'noaa-weather-last.json');

    // Load last known weather data or default
    let lastWeather = { temperature: 20, humidity: 50 };
    if (fs.existsSync(this.cacheFile)) {
      try {
        lastWeather = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      } catch (e) {
        this.platform.log.warn('Failed to read last weather cache:', e);
      }
    }

    this.lastTemperature = lastWeather.temperature;
    this.lastHumidity = lastWeather.humidity;
    accessory.context.weather = lastWeather;

    this.temperatureService =
      accessory.getService(this.platform.api.hap.Service.TemperatureSensor) ||
      accessory.addService(this.platform.api.hap.Service.TemperatureSensor);

    this.humidityService =
      accessory.getService(this.platform.api.hap.Service.HumiditySensor) ||
      accessory.addService(this.platform.api.hap.Service.HumiditySensor);

    // Initialize HomeKit with last cached values
    this.temperatureService.updateCharacteristic(
      this.platform.api.hap.Characteristic.CurrentTemperature,
      lastWeather.temperature,
    );

    this.humidityService.updateCharacteristic(
      this.platform.api.hap.Characteristic.CurrentRelativeHumidity,
      lastWeather.humidity,
    );

    this.platform.log.info(
      `Initialized HomeKit with cached NOAA weather: ${lastWeather.temperature}°C, ${lastWeather.humidity}%`
    );
  }

  updateValues() {
    const weather = this.accessory.context.weather;

    if (weather.temperature === null || weather.humidity === null) {
      this.platform.log.warn(
        'NOAA returned null values. Keeping last known HomeKit values.'
      );
      return;
    }

    const tempChanged =
      this.lastTemperature === null ||
      Math.abs(weather.temperature - this.lastTemperature) >= 0.1;
    const humidityChanged =
      this.lastHumidity === null ||
      Math.abs(weather.humidity - this.lastHumidity) >= 1;

    if (!tempChanged && !humidityChanged) {
      this.platform.log.info(
        `NOAA weather unchanged: ${weather.temperature}°C, ${weather.humidity}% (no characteristic update needed)`
      );
    } else {
      if (tempChanged) {
        this.temperatureService.updateCharacteristic(
          this.platform.api.hap.Characteristic.CurrentTemperature,
          weather.temperature,
        );
        this.lastTemperature = weather.temperature;
      }

      if (humidityChanged) {
        this.humidityService.updateCharacteristic(
          this.platform.api.hap.Characteristic.CurrentRelativeHumidity,
          weather.humidity,
        );
        this.lastHumidity = weather.humidity;
      }

      this.platform.log.info(
        `Updated HomeKit with NOAA weather: ${weather.temperature}°C, ${weather.humidity}%`
      );
    }

    // Always cache last known good values
    try {
      fs.writeFileSync(this.cacheFile, JSON.stringify(weather));
    } catch (e) {
      this.platform.log.error('Failed to write last weather cache:', e);
    }
  }
}
