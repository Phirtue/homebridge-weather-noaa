import { PlatformAccessory, Service } from 'homebridge';
import * as fs from 'fs';
import * as path from 'path';

import { NOAAWeatherPlatform } from './platform';

const TEMP_SUBTYPE = 'noaa-temperature';
const HUMIDITY_SUBTYPE = 'noaa-humidity';
const CHANGE_EPSILON_TEMP = 0.05;
const CHANGE_EPSILON_HUMIDITY = 0.5;

interface WeatherReading {
  temperature: number | null;
  humidity: number | null;
}

export class NOAAWeatherAccessory {
  private readonly temperatureService: Service;
  private readonly humidityService: Service;
  private readonly cacheFile: string;
  private last: WeatherReading = { temperature: null, humidity: null };

  constructor(
    private readonly platform: NOAAWeatherPlatform,
    private readonly accessory: PlatformAccessory,
    pluginVersion: string,
  ) {
    this.cacheFile = path.join(this.platform.api.user.persistPath(), 'noaa-weather-last.json');

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'NOAA / NWS')
      .setCharacteristic(this.platform.Characteristic.Model, 'Weather Station')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'noaa-weather')
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, pluginVersion);

    this.last = this.readCache();

    this.temperatureService =
      this.accessory.getServiceById(this.platform.Service.TemperatureSensor, TEMP_SUBTYPE)
      || this.accessory.addService(
        this.platform.Service.TemperatureSensor, 'NOAA Temperature', TEMP_SUBTYPE,
      );

    this.humidityService =
      this.accessory.getServiceById(this.platform.Service.HumiditySensor, HUMIDITY_SUBTYPE)
      || this.accessory.addService(
        this.platform.Service.HumiditySensor, 'NOAA Humidity', HUMIDITY_SUBTYPE,
      );

    if (this.last.temperature !== null) {
      this.update(
        this.temperatureService,
        this.platform.Characteristic.CurrentTemperature,
        this.last.temperature,
      );
    }
    if (this.last.humidity !== null) {
      this.update(
        this.humidityService,
        this.platform.Characteristic.CurrentRelativeHumidity,
        this.last.humidity,
      );
    }

    this.platform.log.info(
      'Initialized HomeKit with cached NOAA readings: ' +
      `temp=${this.last.temperature ?? 'n/a'}°C humidity=${this.last.humidity ?? 'n/a'}%`,
    );
  }

  /**
   * Apply a fresh reading. Returns true if either characteristic changed
   * meaningfully (used by the platform's adaptive polling).
   * Null fields are ignored — the last known good value is retained.
   */
  applyReading(reading: WeatherReading): boolean {
    let changed = false;

    if (reading.temperature !== null) {
      if (
        this.last.temperature === null ||
        Math.abs(reading.temperature - this.last.temperature) >= CHANGE_EPSILON_TEMP
      ) {
        changed = true;
      }
      this.update(
        this.temperatureService,
        this.platform.Characteristic.CurrentTemperature,
        reading.temperature,
      );
      this.last.temperature = reading.temperature;
    } else {
      this.platform.log.debug('Temperature null; retaining last known value.');
    }

    if (reading.humidity !== null) {
      if (
        this.last.humidity === null ||
        Math.abs(reading.humidity - this.last.humidity) >= CHANGE_EPSILON_HUMIDITY
      ) {
        changed = true;
      }
      this.update(
        this.humidityService,
        this.platform.Characteristic.CurrentRelativeHumidity,
        reading.humidity,
      );
      this.last.humidity = reading.humidity;
    } else {
      this.platform.log.debug('Humidity null; retaining last known value.');
    }

    if (this.last.temperature !== null || this.last.humidity !== null) {
      this.writeCacheAtomic(this.last);
    }

    if (changed) {
      this.platform.log.info(
        `Pushed to HomeKit: temp=${this.last.temperature ?? 'n/a'}°C ` +
        `humidity=${this.last.humidity ?? 'n/a'}%`,
      );
    } else {
      this.platform.log.debug('Reading unchanged within epsilon.');
    }

    return changed;
  }

  private update(
    service: Service,
    characteristic: Parameters<Service['updateCharacteristic']>[0],
    value: number,
  ): void {
    try {
      service.updateCharacteristic(characteristic, value);
    } catch (err) {
      this.platform.log.warn(
        `Failed to update characteristic on ${service.displayName}: ${(err as Error).message}`,
      );
    }
  }

  private readCache(): WeatherReading {
    if (!fs.existsSync(this.cacheFile)) {
      return { temperature: null, humidity: null };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')) as Partial<WeatherReading>;
      const t = typeof parsed.temperature === 'number' && Number.isFinite(parsed.temperature)
        ? parsed.temperature : null;
      const h = typeof parsed.humidity === 'number' && Number.isFinite(parsed.humidity)
        ? Math.max(0, Math.min(100, parsed.humidity)) : null;
      return { temperature: t, humidity: h };
    } catch {
      this.platform.log.warn('Corrupted weather cache - discarding.');
      try {
        fs.unlinkSync(this.cacheFile);
      } catch {
        /* ignore */
      }
      return { temperature: null, humidity: null };
    }
  }

  private writeCacheAtomic(reading: WeatherReading): void {
    const tmp = `${this.cacheFile}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(reading), { mode: 0o600 });
      fs.renameSync(tmp, this.cacheFile);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      this.platform.log.warn(`Failed to persist weather cache: ${(err as Error).message}`);
    }
  }
}
