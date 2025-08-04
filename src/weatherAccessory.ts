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

  private static metrics = {
    cacheResets: 0,
    cacheWriteErrors: 0,
    characteristicErrors: 0,
    serviceRecoveries: 0,
  };

  constructor(
    private readonly platform: NOAAWeatherPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    try {
      const persistPath = this.platform.api.user.persistPath();
      this.cacheFile = path.join(persistPath, 'noaa-weather-last.json');

      let lastWeather = { temperature: 20, humidity: 50 };
      if (fs.existsSync(this.cacheFile)) {
        try {
          lastWeather = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
        } catch (e) {
          NOAAWeatherAccessory.metrics.cacheResets++;
          this.logWarn('Corrupted weather cache detected. Resetting cache.', e);
          try { fs.unlinkSync(this.cacheFile); } catch {}
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

      this.safeUpdateCharacteristic(
        this.temperatureService,
        this.platform.api.hap.Characteristic.CurrentTemperature,
        lastWeather.temperature,
      );

      this.safeUpdateCharacteristic(
        this.humidityService,
        this.platform.api.hap.Characteristic.CurrentRelativeHumidity,
        lastWeather.humidity,
      );

      this.logInfo(`Initialized HomeKit with cached NOAA weather: ${lastWeather.temperature}°C, ${lastWeather.humidity}%`);

      setInterval(() => this.logMetrics(), 60 * 60 * 1000);
      process.on('exit', () => this.logMetrics());
    } catch (err) {
      this.logError('Failed during NOAAWeatherAccessory constructor:', err);
    }
  }

  updateValues() {
    try {
      const weather = this.accessory.context.weather;

      if (weather.temperature === null || weather.humidity === null) {
        this.logWarn('NOAA returned null values. Keeping last known HomeKit values.');
        return;
      }

      this.logInfo(`Pushed NOAA weather to HomeKit: ${weather.temperature}°C, ${weather.humidity}%`);

      this.safeUpdateCharacteristic(
        this.temperatureService,
        this.platform.api.hap.Characteristic.CurrentTemperature,
        weather.temperature,
      );

      this.safeUpdateCharacteristic(
        this.humidityService,
        this.platform.api.hap.Characteristic.CurrentRelativeHumidity,
        weather.humidity,
      );

      try {
        fs.writeFileSync(this.cacheFile, JSON.stringify(weather));
      } catch (e) {
        NOAAWeatherAccessory.metrics.cacheWriteErrors++;
        this.logError('Failed to write last weather cache:', e);
      }

      this.lastTemperature = weather.temperature;
      this.lastHumidity = weather.humidity;
    } catch (err) {
      this.logError('Error updating NOAA weather values:', err);
    }
  }

  private safeUpdateCharacteristic(service: Service, characteristic: any, value: any) {
    try {
      service.updateCharacteristic(characteristic, value);
    } catch (e) {
      NOAAWeatherAccessory.metrics.characteristicErrors++;
      this.logError(`Failed to update HomeKit characteristic ${characteristic.displayName || characteristic}:`, e);

      try {
        if (!this.accessory.getService(service.displayName)) {
          NOAAWeatherAccessory.metrics.serviceRecoveries++;
          this.logWarn(`Service ${service.displayName} missing. Attempting to re-add it.`);
          const newService = this.accessory.addService(service.displayName);
          newService.updateCharacteristic(characteristic, value);
        }
      } catch (recoverErr) {
        this.logError(`Failed to self-recover service ${service.displayName}:`, recoverErr);
      }
    }
  }

  private logMetrics() {
    this.logInfo(
      `📊 NOAA Accessory Metrics → Cache Resets: ${NOAAWeatherAccessory.metrics.cacheResets}, ` +
      `Cache Write Errors: ${NOAAWeatherAccessory.metrics.cacheWriteErrors}, ` +
      `Characteristic Errors: ${NOAAWeatherAccessory.metrics.characteristicErrors}, ` +
      `Service Recoveries: ${NOAAWeatherAccessory.metrics.serviceRecoveries}`
    );
  }

  private logInfo(message: string) {
    this.platform.log.info(this.formatLog(message));
  }
  private logWarn(message: string, data?: any) {
    this.platform.log.warn(this.formatLog(message), data || '');
  }
  private logError(message: string, data?: any) {
    this.platform.log.error(this.formatLog(message), data || '');
  }

  private formatLog(message: string): string {
    const now = new Date();
    const formattedTime = new Intl.DateTimeFormat('en-US', {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      hour12: true,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(now);

    return `[${formattedTime}] ${message}`;
  }
}
