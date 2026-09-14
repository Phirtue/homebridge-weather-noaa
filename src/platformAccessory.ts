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
export const STALE_OBSERVATION_MS = 2 * 60 * 60 * 1000;

interface WeatherReading {
  temperature: number | null;
  humidity: number | null;
  /** Epoch ms of the observation itself, or null when NWS omits the timestamp. */
  observedAt?: number | null;
}

/** On-disk shape. Field names are a compatibility contract with older releases. */
interface CachedWeatherReading {
  temperature: number | null;
  humidity: number | null;
  temperatureObservedAt: number | null;
  humidityObservedAt: number | null;
}

type CharacteristicRef = Parameters<Service['updateCharacteristic']>[0];

/**
 * Everything the accessory tracks about one HomeKit sensor. Temperature
 * and humidity are identical apart from their service, characteristic,
 * change threshold and clamp, so they share this shape and the logic below
 * is written once against it rather than twice against parallel fields.
 */
interface SensorChannel {
  /** Capitalized noun for log lines: "Temperature", "Humidity". */
  readonly label: string;
  readonly service: Service;
  readonly characteristic: CharacteristicRef;
  /** Minimum change that counts as a new reading for adaptive polling. */
  readonly epsilon: number;
  readonly clamp: (value: number) => number;
  /** Last value pushed to HomeKit, or null if none yet. */
  value: number | null;
  /** Epoch ms the current value was observed; drives staleness. */
  observedAt: number | null;
  /** Last StatusActive pushed to HomeKit; null until the first push succeeds. */
  active: boolean | null;
  /** Baseline of what is on disk, so sub-epsilon drift still gets persisted. */
  persistedValue: number | null;
  persistedObservedAt: number | null;
}

/** Model string shown in the Home app before any station has been resolved. */
const MODEL_UNKNOWN_STATION = 'Weather Station';

export class NOAAWeatherAccessory {
  private readonly temperature: SensorChannel;
  private readonly humidity: SensorChannel;
  private readonly information: Service;
  private readonly cacheFile: string;
  private staleTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;

  constructor(
    private readonly platform: NOAAWeatherPlatform,
    private readonly accessory: PlatformAccessory,
    pluginVersion: string,
  ) {
    this.cacheFile = path.join(this.platform.api.user.persistPath(), 'noaa-weather-last.json');

    this.information = this.accessory.getService(this.platform.Service.AccessoryInformation)!;
    this.information
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'NOAA / NWS')
      .setCharacteristic(this.platform.Characteristic.Model, MODEL_UNKNOWN_STATION)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'noaa-weather')
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, pluginVersion);

    const cached = this.readCache();

    this.temperature = this.makeChannel({
      label: 'Temperature',
      service:
        this.accessory.getServiceById(this.platform.Service.TemperatureSensor, TEMP_SUBTYPE)
        || this.accessory.addService(
          this.platform.Service.TemperatureSensor, 'NOAA Temperature', TEMP_SUBTYPE,
        ),
      characteristic: this.platform.Characteristic.CurrentTemperature,
      epsilon: CHANGE_EPSILON_TEMP,
      clamp: clampTemperature,
    }, cached.temperature, cached.temperatureObservedAt);

    this.humidity = this.makeChannel({
      label: 'Humidity',
      service:
        this.accessory.getServiceById(this.platform.Service.HumiditySensor, HUMIDITY_SUBTYPE)
        || this.accessory.addService(
          this.platform.Service.HumiditySensor, 'NOAA Humidity', HUMIDITY_SUBTYPE,
        ),
      characteristic: this.platform.Characteristic.CurrentRelativeHumidity,
      epsilon: CHANGE_EPSILON_HUMIDITY,
      clamp: clampHumidity,
    }, cached.humidity, cached.humidityObservedAt);

    for (const channel of this.channels()) {
      if (channel.value !== null) {
        this.update(channel.service, channel.characteristic, channel.value);
      }
    }

    const now = Date.now();
    const statusUpdateFailed = !this.syncStatusActive(now);
    this.scheduleStaleCheck(now, statusUpdateFailed ? STATUS_UPDATE_RETRY_MS : null);

    this.platform.log.info(
      'Initialized HomeKit with cached NOAA readings: ' +
      `temp=${this.temperature.value ?? 'n/a'}°C humidity=${this.humidity.value ?? 'n/a'}%`,
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

  /**
   * Surface the station feeding the sensors in the Home app's accessory
   * details (Model field), so a user can see which station they are on —
   * and notice a failover — without reading logs. The id has already
   * passed STATION_ID_RE (3–8 alphanumerics), so it needs no sanitizing
   * and stays well inside HAP's 64-character limit for Model.
   */
  setStation(stationId: string): void {
    this.update(this.information, this.platform.Characteristic.Model, `NWS Station ${stationId}`);
  }

  /**
   * Apply a fresh reading. Returns true if either characteristic changed
   * meaningfully (used by the platform's adaptive polling).
   * Null fields are ignored — the last known good value is retained.
   */
  applyReading(reading: WeatherReading): boolean {
    const now = Date.now();
    // A network timestamp must never move the local staleness clock into
    // the future. Clamp any future value to receipt time; also treat a
    // non-finite runtime value as absent despite the TypeScript contract.
    const observedAt =
      typeof reading.observedAt === 'number' && Number.isFinite(reading.observedAt)
        ? Math.min(reading.observedAt, now)
        : null;
    const measurementTime = observedAt ?? now;

    const temperatureChanged =
      this.applyChannel(this.temperature, reading.temperature, measurementTime);
    const humidityChanged =
      this.applyChannel(this.humidity, reading.humidity, measurementTime);
    const changed = temperatureChanged || humidityChanged;

    const statusUpdated = this.syncStatusActive(now);
    this.scheduleStaleCheck(now, statusUpdated ? null : STATUS_UPDATE_RETRY_MS);

    // Compare against the persisted baseline, not only the previous
    // in-memory sample. Otherwise repeated sub-epsilon changes can drift
    // arbitrarily far without ever reaching disk.
    if (this.channels().some((c) => this.hasMeaningfulChange(c) || this.hasNewerFreshness(c))) {
      const cache: CachedWeatherReading = {
        temperature: this.temperature.value,
        humidity: this.humidity.value,
        temperatureObservedAt: this.temperature.observedAt,
        humidityObservedAt: this.humidity.observedAt,
      };
      if (writeJsonAtomic(this.platform.log, this.cacheFile, cache)) {
        for (const channel of this.channels()) {
          channel.persistedValue = channel.value;
          channel.persistedObservedAt = channel.observedAt;
        }
      }
    }

    if (changed) {
      this.platform.log.info(
        `Pushed to HomeKit: temp=${this.temperature.value ?? 'n/a'}°C ` +
        `humidity=${this.humidity.value ?? 'n/a'}%`,
      );
    } else {
      this.platform.log.debug('Reading unchanged within epsilon.');
    }

    return changed;
  }

  private makeChannel(
    fixed: Pick<SensorChannel, 'label' | 'service' | 'characteristic' | 'epsilon' | 'clamp'>,
    cachedValue: number | null,
    cachedObservedAt: number | null,
  ): SensorChannel {
    return {
      ...fixed,
      value: cachedValue,
      observedAt: cachedObservedAt,
      active: null,
      persistedValue: cachedValue,
      persistedObservedAt: cachedObservedAt,
    };
  }

  private channels(): SensorChannel[] {
    return [this.temperature, this.humidity];
  }

  /** Push one channel's new value, if any. Returns whether it changed meaningfully. */
  private applyChannel(
    channel: SensorChannel,
    raw: number | null,
    measurementTime: number,
  ): boolean {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      this.platform.log.debug(`${channel.label} null; retaining last known value.`);
      return false;
    }
    const value = channel.clamp(raw);
    const changed =
      channel.value === null || Math.abs(value - channel.value) >= channel.epsilon;
    this.update(channel.service, channel.characteristic, value);
    channel.value = value;
    channel.observedAt = measurementTime;
    return changed;
  }

  private setActive(channel: SensorChannel, active: boolean): boolean {
    if (active === channel.active) {
      return true;
    }
    if (!this.update(channel.service, this.platform.Characteristic.StatusActive, active)) {
      return false;
    }
    channel.active = active;
    const noun = channel.label.toLowerCase();
    if (active) {
      this.platform.log.info(`Fresh ${noun} received; ${noun} sensor marked active.`);
    } else if (channel.value !== null) {
      this.platform.log.warn(
        `${channel.label} observation is stale; ${noun} sensor marked inactive.`,
      );
    }
    return true;
  }

  private isFresh(channel: SensorChannel, now: number): boolean {
    return (
      channel.value !== null &&
      channel.observedAt !== null &&
      now - channel.observedAt <= STALE_OBSERVATION_MS
    );
  }

  /** Returns false if any StatusActive push failed (caller schedules a retry). */
  private syncStatusActive(now: number): boolean {
    // Evaluate both channels even if the first fails: `every` would
    // short-circuit and leave the second sensor's status unsynced.
    const results = this.channels().map((c) => this.setActive(c, this.isFresh(c, now)));
    return results.every(Boolean);
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
    const deadlines: number[] = [];
    for (const channel of this.channels()) {
      if (channel.value !== null && channel.observedAt !== null) {
        const deadline = channel.observedAt + STALE_OBSERVATION_MS;
        if (deadline >= now) {
          deadlines.push(deadline);
        }
      }
    }
    if (retryInMs !== null) {
      deadlines.push(now + retryInMs);
    }
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

  private hasMeaningfulChange(channel: SensorChannel): boolean {
    return (
      channel.value !== null &&
      (channel.persistedValue === null ||
        Math.abs(channel.value - channel.persistedValue) >= channel.epsilon)
    );
  }

  private hasNewerFreshness(channel: SensorChannel): boolean {
    return (
      channel.value !== null &&
      channel.observedAt !== null &&
      (channel.persistedObservedAt === null ||
        channel.observedAt - channel.persistedObservedAt >= CACHE_FRESHNESS_WRITE_INTERVAL_MS)
    );
  }

  private update(
    service: Service,
    characteristic: CharacteristicRef,
    value: number | boolean | string,
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
    const empty: CachedWeatherReading = {
      temperature: null,
      humidity: null,
      temperatureObservedAt: null,
      humidityObservedAt: null,
    };
    if (!fs.existsSync(this.cacheFile)) {
      return empty;
    }
    try {
      const parsed = readJsonBounded(this.cacheFile) as Partial<CachedWeatherReading>;
      const now = Date.now();
      const finite = (v: unknown): number | null =>
        typeof v === 'number' && Number.isFinite(v) ? v : null;
      const t = finite(parsed.temperature);
      const h = finite(parsed.humidity);
      const tAt = finite(parsed.temperatureObservedAt);
      const hAt = finite(parsed.humidityObservedAt);
      return {
        temperature: t === null ? null : clampTemperature(t),
        humidity: h === null ? null : clampHumidity(h),
        // Cached timestamps, like network ones, may never sit in the future.
        temperatureObservedAt: tAt === null ? null : Math.min(tAt, now),
        humidityObservedAt: hAt === null ? null : Math.min(hAt, now),
      };
    } catch {
      this.platform.log.warn('Corrupted weather cache - discarding.');
      try {
        fs.unlinkSync(this.cacheFile);
      } catch {
        /* ignore */
      }
      return empty;
    }
  }
}
