import type { PlatformAccessory, Service } from 'homebridge';
import * as fs from 'fs';
import * as path from 'path';

import { NOAAWeatherPlatform } from './platform.js';
import { writeJsonAtomic } from './stationCache.js';

const TEMP_SUBTYPE = 'noaa-temperature';
const HUMIDITY_SUBTYPE = 'noaa-humidity';
const CHANGE_EPSILON_TEMP = 0.05;
const CHANGE_EPSILON_HUMIDITY = 0.5;

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

export class NOAAWeatherAccessory {
  private readonly temperatureService: Service;
  private readonly humidityService: Service;
  private readonly cacheFile: string;
  private last: WeatherReading = { temperature: null, humidity: null };
  private statusActive = true;

  /**
   * When the last applied observation was taken (falls back to apply time
   * if NWS omits the timestamp). Initialized to boot time: a boot from
   * cache where no poll ever succeeds must eventually go inactive rather
   * than presenting cached readings as current forever. In-memory only;
   * observation timestamps are deliberately not persisted.
   */
  private lastObservationAppliedMs = Date.now();

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

    // Cached readings carry no observation timestamp, so staleness cannot
    // be judged at boot. Start active; the first live poll (within a
    // minute) settles it.
    this.update(this.temperatureService, this.platform.Characteristic.StatusActive, true);
    this.update(this.humidityService, this.platform.Characteristic.StatusActive, true);

    this.platform.log.info(
      'Initialized HomeKit with cached NOAA readings: ' +
      `temp=${this.last.temperature ?? 'n/a'}°C humidity=${this.last.humidity ?? 'n/a'}%`,
    );
  }

  /**
   * Called by the platform when a poll fails outright. applyReading()
   * evaluates staleness from the observation timestamp, but it only runs
   * on successful polls; without this hook, an indefinite fetch failure
   * (WAN down, NWS outage, DNS breakage) would leave the sensors active
   * while HomeKit presents arbitrarily old readings as current.
   */
  noteObservationFailure(): void {
    if (Date.now() - this.lastObservationAppliedMs > STALE_OBSERVATION_MS) {
      this.setStatusActive(false);
    }
  }

  /**
   * Mark both sensors active or inactive in HomeKit. A dark station keeps
   * returning its last observation; without this, automations keyed off
   * outdoor temperature would act on week-old data presented as current.
   */
  private setStatusActive(active: boolean): void {
    if (active === this.statusActive) {
      return;
    }
    this.statusActive = active;
    if (active) {
      this.platform.log.info('Station reporting again; sensors marked active.');
    } else {
      this.platform.log.warn(
        'Observation is stale (station may be offline); sensors marked inactive.',
      );
    }
    this.update(this.temperatureService, this.platform.Characteristic.StatusActive, active);
    this.update(this.humidityService, this.platform.Characteristic.StatusActive, active);
  }

  /**
   * Apply a fresh reading. Returns true if either characteristic changed
   * meaningfully (used by the platform's adaptive polling).
   * Null fields are ignored — the last known good value is retained.
   */
  applyReading(reading: WeatherReading): boolean {
    let changed = false;

    this.lastObservationAppliedMs = reading.observedAt ?? Date.now();
    if (reading.observedAt !== null && reading.observedAt !== undefined) {
      this.setStatusActive(Date.now() - reading.observedAt <= STALE_OBSERVATION_MS);
    }

    if (reading.temperature !== null) {
      const temperature = clampTemperature(reading.temperature);
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

    // Persist only when a value actually changed: identical data is not
    // worth a write+rename cycle against what is often an SD card. The
    // in-memory value may lead the persisted one by up to the change
    // epsilon, which is negligible for a restart cache.
    if (changed && (this.last.temperature !== null || this.last.humidity !== null)) {
      writeJsonAtomic(this.platform.log, this.cacheFile, this.last);
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
    value: number | boolean,
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
        ? clampTemperature(parsed.temperature) : null;
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
}
