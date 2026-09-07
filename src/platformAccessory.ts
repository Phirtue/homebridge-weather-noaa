import type { PlatformAccessory, Service } from 'homebridge';
import * as fs from 'fs';
import * as path from 'path';

import { NOAAWeatherPlatform } from './platform.js';
import { readJsonBounded, writeJsonAtomic } from './stationCache.js';

const TEMP_SUBTYPE = 'noaa-temperature';
const HUMIDITY_SUBTYPE = 'noaa-humidity';
const CHANGE_EPSILON_TEMP = 0.05;
const CHANGE_EPSILON_HUMIDITY = 0.5;
const CACHE_FRESHNESS_WRITE_INTERVAL_MS = 60 * 60 * 1000;
const STATUS_UPDATE_RETRY_MS = 60 * 1000;

/**
 * HomeKit's CurrentTemperature characteristic accepts -270..100 °C. Values
 * outside that range (corrupt cache file, bad API data) are clamped so the
 * characteristic update cannot fail.
 */
const TEMP_MIN_C = -270;
const TEMP_MAX_C = 100;

function clampTemperature(value: number): number {
  return Math.max(TEMP_MIN_C, Math.min(TEMP_MAX_C, value));
}

function clampHumidity(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/**
 * Observations older than this are treated as stale and the sensors are
 * marked inactive. NWS stations typically report hourly and QC processing
 * can add up to 20 minutes; two hours of silence means the station is dark
 * (AWOS sites do this routinely) and HomeKit should not present the last
 * reading as current.
 */
const STALE_OBSERVATION_MS = 2 * 60 * 60 * 1000;

interface WeatherReading {
  temperature: number | null;
  humidity: number | null;
  /** Epoch ms of the observation itself, or null when NWS omits the timestamp. */
  observedAt?: number | null;
}

interface CachedWeatherReading {
  temperature: number | null;
  humidity: number | null;
  temperatureObservedAt: number | null;
  humidityObservedAt: number | null;
}

export class NOAAWeatherAccessory {
  private readonly temperatureService: Service;
  private readonly humidityService: Service;
  private readonly cacheFile: string;
  private last: WeatherReading = { temperature: null, humidity: null };
  private persistedTemperature: number | null = null;
  private persistedHumidity: number | null = null;
  private persistedTemperatureObservedAt: number | null = null;
  private persistedHumidityObservedAt: number | null = null;
  private temperatureObservedAt: number | null = null;
  private humidityObservedAt: number | null = null;
  private temperatureActive: boolean | null = null;
  private humidityActive: boolean | null = null;
  private staleTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;

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

    const cached = this.readCache();
    this.last = {
      temperature: cached.temperature,
      humidity: cached.humidity,
    };
    this.temperatureObservedAt = cached.temperatureObservedAt;
    this.humidityObservedAt = cached.humidityObservedAt;
    this.persistedTemperature = cached.temperature;
    this.persistedHumidity = cached.humidity;
    this.persistedTemperatureObservedAt = cached.temperatureObservedAt;
    this.persistedHumidityObservedAt = cached.humidityObservedAt;

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

    const now = Date.now();
    const statusUpdateFailed = !this.syncStatusActive(now);
    this.scheduleStaleCheck(now, statusUpdateFailed ? STATUS_UPDATE_RETRY_MS : null);

    this.platform.log.info(
      'Initialized HomeKit with cached NOAA readings: ' +
      `temp=${this.last.temperature ?? 'n/a'}°C humidity=${this.last.humidity ?? 'n/a'}%`,
    );
  }

  /**
   * Called by the platform when a poll fails outright. The deadline timer
   * handles normal expiry; this also re-evaluates immediately after long
   * event-loop suspension or clock changes.
   */
  noteObservationFailure(): void {
    this.evaluateStaleness();
  }

  shutdown(): void {
    this.shuttingDown = true;
    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
      this.staleTimer = null;
    }
  }

  private setTemperatureActive(active: boolean): boolean {
    if (active === this.temperatureActive) {
      return true;
    }
    if (!this.update(
      this.temperatureService,
      this.platform.Characteristic.StatusActive,
      active,
    )) {
      return false;
    }
    this.temperatureActive = active;
    if (active) {
      this.platform.log.info('Fresh temperature received; temperature sensor marked active.');
    } else if (this.last.temperature !== null) {
      this.platform.log.warn(
        'Temperature observation is stale; temperature sensor marked inactive.',
      );
    }
    return true;
  }

  private setHumidityActive(active: boolean): boolean {
    if (active === this.humidityActive) {
      return true;
    }
    if (!this.update(
      this.humidityService,
      this.platform.Characteristic.StatusActive,
      active,
    )) {
      return false;
    }
    this.humidityActive = active;
    if (active) {
      this.platform.log.info('Fresh humidity received; humidity sensor marked active.');
    } else if (this.last.humidity !== null) {
      this.platform.log.warn(
        'Humidity observation is stale; humidity sensor marked inactive.',
      );
    }
    return true;
  }

  private syncStatusActive(now: number): boolean {
    const temperatureShouldBeActive =
      this.last.temperature !== null &&
      this.temperatureObservedAt !== null &&
      now - this.temperatureObservedAt <= STALE_OBSERVATION_MS;
    const humidityShouldBeActive =
      this.last.humidity !== null &&
      this.humidityObservedAt !== null &&
      now - this.humidityObservedAt <= STALE_OBSERVATION_MS;
    const temperatureUpdated = this.setTemperatureActive(temperatureShouldBeActive);
    const humidityUpdated = this.setHumidityActive(humidityShouldBeActive);
    return temperatureUpdated && humidityUpdated;
  }

  private evaluateStaleness(now = Date.now()): void {
    const statusUpdated = this.syncStatusActive(now);
    this.scheduleStaleCheck(now, statusUpdated ? null : STATUS_UPDATE_RETRY_MS);
  }

  /**
   * Expire readings at their actual two-hour deadlines. Poll callbacks
   * alone are insufficient because supported adaptive intervals can be
   * much longer than the stale threshold.
   */
  private scheduleStaleCheck(now = Date.now(), retryInMs: number | null = null): void {
    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
      this.staleTimer = null;
    }
    if (this.shuttingDown) {
      return;
    }
    const deadlines = [
      this.last.temperature !== null && this.temperatureObservedAt !== null &&
        this.temperatureObservedAt + STALE_OBSERVATION_MS >= now
        ? this.temperatureObservedAt + STALE_OBSERVATION_MS
        : null,
      this.last.humidity !== null && this.humidityObservedAt !== null &&
        this.humidityObservedAt + STALE_OBSERVATION_MS >= now
        ? this.humidityObservedAt + STALE_OBSERVATION_MS
        : null,
      retryInMs !== null ? now + retryInMs : null,
    ].filter((deadline): deadline is number => deadline !== null);
    if (deadlines.length === 0) {
      return;
    }
    const delay = Math.max(1, Math.min(...deadlines) - now + 1);
    this.staleTimer = setTimeout(() => {
      this.staleTimer = null;
      this.evaluateStaleness();
    }, delay);
    this.staleTimer.unref();
  }

  /**
   * Apply a fresh reading. Returns true if either characteristic changed
   * meaningfully (used by the platform's adaptive polling).
   * Null fields are ignored — the last known good value is retained.
   */
  applyReading(reading: WeatherReading): boolean {
    let changed = false;

    const now = Date.now();
    const temperature =
      typeof reading.temperature === 'number' && Number.isFinite(reading.temperature)
        ? clampTemperature(reading.temperature)
        : null;
    const humidity =
      typeof reading.humidity === 'number' && Number.isFinite(reading.humidity)
        ? clampHumidity(reading.humidity)
        : null;
    // A network timestamp must never move the local staleness clock into
    // the future. Clamp any future value to receipt time; also treat a
    // non-finite runtime value as absent despite the TypeScript contract.
    const observedAt =
      typeof reading.observedAt === 'number' && Number.isFinite(reading.observedAt)
        ? Math.min(reading.observedAt, now)
        : null;
    const measurementTime = observedAt ?? now;

    if (temperature !== null) {
      if (
        this.last.temperature === null ||
        Math.abs(temperature - this.last.temperature) >= CHANGE_EPSILON_TEMP
      ) {
        changed = true;
      }
      this.update(
        this.temperatureService,
        this.platform.Characteristic.CurrentTemperature,
        temperature,
      );
      this.last.temperature = temperature;
      this.temperatureObservedAt = measurementTime;
    } else {
      this.platform.log.debug('Temperature null; retaining last known value.');
    }

    if (humidity !== null) {
      if (
        this.last.humidity === null ||
        Math.abs(humidity - this.last.humidity) >= CHANGE_EPSILON_HUMIDITY
      ) {
        changed = true;
      }
      this.update(
        this.humidityService,
        this.platform.Characteristic.CurrentRelativeHumidity,
        humidity,
      );
      this.last.humidity = humidity;
      this.humidityObservedAt = measurementTime;
    } else {
      this.platform.log.debug('Humidity null; retaining last known value.');
    }
    const statusUpdated = this.syncStatusActive(now);
    this.scheduleStaleCheck(now, statusUpdated ? null : STATUS_UPDATE_RETRY_MS);

    // Compare against the persisted baseline, not only the previous
    // in-memory sample. Otherwise repeated sub-epsilon changes can drift
    // arbitrarily far without ever reaching disk.
    const shouldPersist =
      this.hasMeaningfulChange(
        this.last.temperature,
        this.persistedTemperature,
        CHANGE_EPSILON_TEMP,
      ) ||
      this.hasMeaningfulChange(
        this.last.humidity,
        this.persistedHumidity,
        CHANGE_EPSILON_HUMIDITY,
      ) ||
      this.hasNewerFreshness(
        temperature,
        this.temperatureObservedAt,
        this.persistedTemperatureObservedAt,
      ) ||
      this.hasNewerFreshness(
        humidity,
        this.humidityObservedAt,
        this.persistedHumidityObservedAt,
      );
    if (shouldPersist) {
      const cache: CachedWeatherReading = {
        temperature: this.last.temperature,
        humidity: this.last.humidity,
        temperatureObservedAt: this.temperatureObservedAt,
        humidityObservedAt: this.humidityObservedAt,
      };
      if (writeJsonAtomic(this.platform.log, this.cacheFile, cache)) {
        this.persistedTemperature = this.last.temperature;
        this.persistedHumidity = this.last.humidity;
        this.persistedTemperatureObservedAt = this.temperatureObservedAt;
        this.persistedHumidityObservedAt = this.humidityObservedAt;
      }
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

  private hasMeaningfulChange(
    current: number | null,
    persisted: number | null,
    epsilon: number,
  ): boolean {
    return current !== null && (persisted === null || Math.abs(current - persisted) >= epsilon);
  }

  private hasNewerFreshness(
    currentValue: number | null,
    observedAt: number | null,
    persistedObservedAt: number | null,
  ): boolean {
    return (
      currentValue !== null &&
      observedAt !== null &&
      (
        persistedObservedAt === null ||
        observedAt - persistedObservedAt >= CACHE_FRESHNESS_WRITE_INTERVAL_MS
      )
    );
  }

  private update(
    service: Service,
    characteristic: Parameters<Service['updateCharacteristic']>[0],
    value: number | boolean,
  ): boolean {
    try {
      service.updateCharacteristic(characteristic, value);
      return true;
    } catch (err) {
      this.platform.log.warn(
        `Failed to update characteristic on ${service.displayName}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  private readCache(): CachedWeatherReading {
    if (!fs.existsSync(this.cacheFile)) {
      return {
        temperature: null,
        humidity: null,
        temperatureObservedAt: null,
        humidityObservedAt: null,
      };
    }
    try {
      const parsed = readJsonBounded(this.cacheFile) as Partial<CachedWeatherReading>;
      const t = typeof parsed.temperature === 'number' && Number.isFinite(parsed.temperature)
        ? clampTemperature(parsed.temperature) : null;
      const h = typeof parsed.humidity === 'number' && Number.isFinite(parsed.humidity)
        ? clampHumidity(parsed.humidity) : null;
      const now = Date.now();
      const temperatureObservedAt =
        typeof parsed.temperatureObservedAt === 'number' &&
        Number.isFinite(parsed.temperatureObservedAt)
          ? Math.min(parsed.temperatureObservedAt, now)
          : null;
      const humidityObservedAt =
        typeof parsed.humidityObservedAt === 'number' &&
        Number.isFinite(parsed.humidityObservedAt)
          ? Math.min(parsed.humidityObservedAt, now)
          : null;
      return { temperature: t, humidity: h, temperatureObservedAt, humidityObservedAt };
    } catch {
      this.platform.log.warn('Corrupted weather cache - discarding.');
      try {
        fs.unlinkSync(this.cacheFile);
      } catch {
        /* ignore */
      }
      return {
        temperature: null,
        humidity: null,
        temperatureObservedAt: null,
        humidityObservedAt: null,
      };
    }
  }
}
