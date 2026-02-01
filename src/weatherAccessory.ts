import { Service, PlatformAccessory } from 'homebridge';
import fs from 'fs';
import path from 'path';
import { NOAAWeatherPlatform } from './platform';

// Stable subtypes to avoid service collisions
const TEMP_SUBTYPE = 'noaa-temperature';
const HUMIDITY_SUBTYPE = 'noaa-humidity';

interface WeatherData {
  temperature: number | null;
  humidity: number | null;
}

export class NOAAWeatherAccessory {
  private temperatureService: Service;
  private humidityService: Service;
  private readonly cacheFile: string;
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
    const persistPath = this.platform.api.user.persistPath();
    this.cacheFile = path.join(persistPath, 'noaa-weather-last.json');

    let lastWeather: WeatherData = { temperature: 20, humidity: 50 };
    if (fs.existsSync(this.cacheFile)) {
      try {
        const cacheContent = fs.readFileSync(this.cacheFile, 'utf8');
        lastWeather = JSON.parse(cacheContent) as WeatherData;
      } catch {
        NOAAWeatherAccessory.metrics.cacheResets++;
        this.logWarn('Corrupted weather cache detected. Resetting cache.');
        try { fs.unlinkSync(this.cacheFile); } catch { /* ignore */ }
      }
    }

    this.lastTemperature = lastWeather.temperature;
    this.lastHumidity = lastWeather.humidity;
    accessory.context.weather = lastWeather;

    // Use getServiceById with stable subtypes to avoid collisions
    this.temperatureService =
      this.accessory.getServiceById(this.platform.api.hap.Service.TemperatureSensor, TEMP_SUBTYPE) ||
      this.accessory.addService(
        this.platform.api.hap.Service.TemperatureSensor,
        'NOAA Temperature',
        TEMP_SUBTYPE,
      );

    this.humidityService =
      this.accessory.getServiceById(this.platform.api.hap.Service.HumiditySensor, HUMIDITY_SUBTYPE) ||
      this.accessory.addService(
        this.platform.api.hap.Service.HumiditySensor,
        'NOAA Humidity',
        HUMIDITY_SUBTYPE,
      );

    if (lastWeather.temperature !== null) {
      this.safeUpdateCharacteristic(
        this.temperatureService,
        this.platform.api.hap.Characteristic.CurrentTemperature,
        lastWeather.temperature,
      );
    }

    if (lastWeather.humidity !== null) {
      this.safeUpdateCharacteristic(
        this.humidityService,
        this.platform.api.hap.Characteristic.CurrentRelativeHumidity,
        lastWeather.humidity,
      );
    }

    this.logInfo(`Initialized HomeKit with cached NOAA weather: ${lastWeather.temperature}°C, ${lastWeather.humidity}%`);

    setInterval(() => this.logMetrics(), 60 * 60 * 1000);
    process.on('exit', () => this.logMetrics());
  }

  updateValues(): void {
    try {
      const weather = this.accessory.context.weather as WeatherData;

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
      } catch {
        NOAAWeatherAccessory.metrics.cacheWriteErrors++;
        this.logError('Failed to write last weather cache');
      }

      this.lastTemperature = weather.temperature;
      this.lastHumidity = weather.humidity;
    } catch (err) {
      this.logError('Error updating NOAA weather values:', err);
    }
  }

  /**
   * Safely update a HomeKit characteristic.
   * Uses `any` for characteristic param to avoid HAP typing issues across Homebridge versions.
   */
  private safeUpdateCharacteristic(
    service: Service,
    characteristic: any,
    value: number,
  ): void {
    try {
      service.updateCharacteristic(characteristic, value);
    } catch {
      NOAAWeatherAccessory.metrics.characteristicErrors++;
      this.logError('Failed to update HomeKit characteristic');

      try {
        let newService: Service | null = null;

        if (service.UUID === this.platform.api.hap.Service.TemperatureSensor.UUID) {
          newService = this.accessory.addService(
            this.platform.api.hap.Service.TemperatureSensor,
            'NOAA Temperature',
            TEMP_SUBTYPE,
          );
        } else if (service.UUID === this.platform.api.hap.Service.HumiditySensor.UUID) {
          newService = this.accessory.addService(
            this.platform.api.hap.Service.HumiditySensor,
            'NOAA Humidity',
            HUMIDITY_SUBTYPE,
          );
        }

        if (newService) {
          NOAAWeatherAccessory.metrics.serviceRecoveries++;
          newService.updateCharacteristic(characteristic, value);
          this.logInfo(`Recovered and updated ${service.displayName} service successfully.`);
        } else {
          this.logWarn(`Could not match service type for recovery: ${service.displayName}`);
        }
      } catch (recoverErr) {
        this.logError(`Failed to self-recover service ${service.displayName}:`, recoverErr);
      }
    }
  }

  private logMetrics(): void {
    this.logInfo(
      `📊 NOAA Accessory Metrics → Cache Resets: ${NOAAWeatherAccessory.metrics.cacheResets}, ` +
      `Cache Write Errors: ${NOAAWeatherAccessory.metrics.cacheWriteErrors}, ` +
      `Characteristic Errors: ${NOAAWeatherAccessory.metrics.characteristicErrors}, ` +
      `Service Recoveries: ${NOAAWeatherAccessory.metrics.serviceRecoveries}`
    );
  }

  private logInfo(message: string): void {
    this.platform.log.info(this.formatLog(message));
  }

  private logWarn(message: string): void {
    this.platform.log.warn(this.formatLog(message));
  }

  private logError(message: string, data?: unknown): void {
    if (data !== undefined) {
      this.platform.log.error(this.formatLog(message), data);
    } else {
      this.platform.log.error(this.formatLog(message));
    }
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
