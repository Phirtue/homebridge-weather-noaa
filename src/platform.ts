// Type-only import: runtime values come from the `api` object Homebridge
// passes in, so nothing is require()'d from the (ESM in v2) homebridge package.
import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';
import * as path from 'path';

import { NOAAWeatherAccessory } from './platformAccessory.js';
import { NwsClient, NWS_API_BASE, withJitter } from './nwsClient.js';
import {
  isObservationFresh,
  isStationUnavailable,
  ObservationPoller,
  ParsedObservation,
  StationSelection,
  UnusableObservationError,
} from './poller.js';
import { sanitizeForLog } from './sanitize.js';
import { PLATFORM_NAME, PLUGIN_NAME, PLUGIN_VERSION } from './settings.js';
import {
  readStationCache, writeJsonAtomic, GRID_ID_RE, STATION_ID_RE, PointsCache,
} from './stationCache.js';

/**
 * Coordinates are rounded to 2 decimals (~1.1 km) before they leave the
 * process. NWS resolves a point to a 2.5 km forecast grid cell and lists
 * that cell's observation stations, so neighbourhood-level precision
 * selects the same station in practice while sending NWS (and writing to
 * the cache file) something well short of a street address. Users who
 * need a specific station set `stationId`. The NWS API itself accepts at
 * most 4 decimals and 301-redirects anything longer.
 */
export const COORD_DECIMALS = 2;

/**
 * MADIS QC flags treated as acceptable for HomeKit display:
 *   V = passed all QC checks (best)
 *   C = passed coarse QC checks
 *   S = passed spatial QC checks
 *   G = subjective good (manually verified by a human)
 *   Z = no QC performed (raw — many ASOS/AWOS sites report this)
 * Rejected: X (failed), Q (questionable), B (subjective bad), T (virtual).
 * https://madis.ncep.noaa.gov/madis_sfc_qc_notes.shtml
 */
const ACCEPTABLE_QC = new Set(['V', 'C', 'S', 'G', 'Z']);

/**
 * Refresh interval bounds in minutes. The floor protects the free NWS API;
 * the ceiling matches config.schema.json, which only binds through the
 * Homebridge UI — a hand-edited config.json can hold any finite number.
 * Without the ceiling, baseRefreshMs × the poller's adaptive multiplier
 * could exceed Node's 2^31-1 ms setTimeout limit, which Node clamps to
 * 1 ms: the failure mode would be a continuous request loop, the exact
 * inverse of the configured intent.
 */
const REFRESH_MIN_MINUTES = 5;
const REFRESH_MAX_MINUTES = 1440;

/**
 * Backoff schedule for retrying station discovery after a startup failure
 * (e.g. Homebridge boots before the WAN link is up). Doubles from 1 minute
 * to a 15 minute ceiling and retries indefinitely.
 */
const DISCOVERY_RETRY_INITIAL_MS = 60_000;
const DISCOVERY_RETRY_MAX_MS = 15 * 60_000;
const MAX_STATION_CANDIDATES = 10;

/**
 * A wall clock earlier than this is not a real time. Raspberry Pis have no
 * RTC and boot at the epoch (or the last shutdown time) until NTP syncs;
 * Homebridge often starts first. Acting on such a clock would write
 * nonsense timestamps into both cache files, mark fresh readings stale
 * (or stale readings fresh), and force station rediscovery on every boot.
 * The floor is a fixed past date, not the build time, so builds stay
 * reproducible; a floor that is merely old can only under-detect, never
 * misfire on a correct clock.
 */
export const CLOCK_SANITY_FLOOR_MS = Date.parse('2026-01-01T00:00:00Z');

/** Validated plugin configuration; null when required fields are unusable. */
interface PluginConfig {
  latitude: number;
  longitude: number;
  baseRefreshMs: number;
  adaptivePolling: boolean;
  stationId: string | null;
}

interface PointResponse {
  properties?: {
    gridId?: unknown;
    gridX?: unknown;
    gridY?: unknown;
  };
}

interface GridpointStationsResponse {
  features?: Array<{ properties?: { stationIdentifier?: unknown } }>;
}

interface QuantitativeValue {
  value?: unknown;
  unitCode?: unknown;
  qualityControl?: unknown;
}

interface ObservationResponse {
  properties?: {
    timestamp?: string;
    temperature?: QuantitativeValue;
    relativeHumidity?: QuantitativeValue;
    presentWeather?: unknown;
  };
}

interface AutoStationContext {
  latitude: number;
  longitude: number;
  cacheFile: string;
}

export class NOAAWeatherPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: Map<string, PlatformAccessory> = new Map();

  private readonly client: NwsClient;
  private readonly timers = new Set<NodeJS.Timeout>();
  private stationCacheResets = 0;
  private discoveryRetryMs = DISCOVERY_RETRY_INITIAL_MS;
  private assumedCelsiusLogged = false;
  private handler: NOAAWeatherAccessory | null = null;
  private poller: ObservationPoller | null = null;
  private shuttingDown = false;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.client = new NwsClient(log, this.buildUserAgent());

    this.log.debug('Finished initializing platform:', this.config.name);

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices().catch((err) => {
        this.log.error('Unhandled error in discoverDevices:', err);
      });
    });

    this.api.on('shutdown', () => this.shutdown());

    const metricsTimer = setInterval(() => this.logMetrics(), 60 * 60 * 1000);
    metricsTimer.unref();
    this.timers.add(metricsTimer);
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  private shutdown(): void {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    this.poller?.stop();
    this.handler?.shutdown();
    this.client.shutdown();
    for (const t of this.timers) {
      clearInterval(t);
      clearTimeout(t);
    }
    this.timers.clear();
    this.logMetrics();
  }

  /**
   * Parse and validate all config values in one place. Returns null (and
   * logs why) when the plugin cannot start.
   */
  private parseConfig(): PluginConfig | null {
    const raw = this.config as Record<string, unknown>;

    const toNumber = (v: unknown): number | undefined => {
      if (v === null || v === undefined || v === '') {
        return undefined;
      }
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };

    const latitude = toNumber(raw.latitude);
    const longitude = toNumber(raw.longitude);
    if (
      latitude === undefined || longitude === undefined ||
      latitude < -90 || latitude > 90 ||
      longitude < -180 || longitude > 180
    ) {
      this.log.error('Latitude and Longitude must be valid numbers within range. Plugin will not start.');
      return null;
    }

    const requestedMinutes = toNumber(raw.refreshInterval) ?? 15;
    const refreshMinutes = Math.min(
      REFRESH_MAX_MINUTES, Math.max(REFRESH_MIN_MINUTES, requestedMinutes),
    );
    if (refreshMinutes !== requestedMinutes) {
      this.log.warn(
        `refreshInterval ${requestedMinutes} is outside ` +
        `${REFRESH_MIN_MINUTES}-${REFRESH_MAX_MINUTES} minutes; using ${refreshMinutes}.`,
      );
    }

    let adaptivePolling = true;
    if (typeof raw.adaptivePolling === 'boolean') {
      adaptivePolling = raw.adaptivePolling;
    } else if (typeof raw.adaptivePolling === 'string') {
      adaptivePolling = raw.adaptivePolling.toLowerCase() === 'true';
    }

    let stationId: string | null = null;
    if (typeof raw.stationId === 'string' && raw.stationId.length > 0) {
      const upper = raw.stationId.trim().toUpperCase();
      if (STATION_ID_RE.test(upper)) {
        stationId = upper;
      } else {
        this.log.warn(
          `Configured stationId "${sanitizeForLog(raw.stationId, 32)}" is invalid ` +
          '(expected 3-8 alphanumerics). Falling back to auto-discovery.',
        );
      }
    }

    const round = (v: number): number => Number(v.toFixed(COORD_DECIMALS));

    return {
      latitude: round(latitude),
      longitude: round(longitude),
      baseRefreshMs: refreshMinutes * 60 * 1000,
      adaptivePolling,
      stationId,
    };
  }

  /**
   * NWS-recommended User-Agent format: "(myapp.com, contact)".
   * https://www.weather.gov/documentation/services-web-api
   *
   * The optional contact field has control characters stripped (CR/LF
   * would be header injection; the rest make undici reject the header and
   * fail every request) and is length-capped, so a misconfigured
   * config.json value cannot break or abuse the request.
   */
  private buildUserAgent(): string {
    const contactRaw = (this.config as Record<string, unknown>).userAgentContact;
    const home = 'github.com/Phirtue/homebridge-weather-noaa';
    if (typeof contactRaw === 'string' && contactRaw.trim().length > 0) {
      // HTTP field values are ByteStrings in Node. Keep the operator-supplied
      // contact to printable ASCII so pasted Unicode cannot make Headers
      // construction reject every NOAA request.
      const clean = contactRaw.trim().replace(/[^\u0020-\u007e]/g, '').slice(0, 200);
      if (clean.length > 0) {
        return `homebridge-weather-noaa/${PLUGIN_VERSION} (${home}, ${clean})`;
      }
    }
    return `homebridge-weather-noaa/${PLUGIN_VERSION} (${home})`;
  }

  private async discoverDevices(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    const cfg = this.parseConfig();
    if (!cfg) {
      return;
    }
    if (Date.now() < CLOCK_SANITY_FLOOR_MS) {
      // Touch nothing — not the caches, not the accessory's staleness
      // state — until the system clock is plausible. The discovery retry
      // backoff (1 → 15 min) already exists for "network not up yet"; the
      // same loop waits for NTP here.
      this.log.warn(
        `System clock reads ${new Date().toISOString()}, which is before this ` +
        'plugin was built; waiting for time synchronization.',
      );
      this.scheduleDiscoveryRetry('Station discovery deferred');
      return;
    }
    const cacheFile = path.join(this.api.user.persistPath(), 'noaa-points-cache.json');

    // Stable UUID — preserved from v1.5 so existing HomeKit room assignments
    // and automations survive the upgrade.
    const uuid = this.api.hap.uuid.generate('noaa-weather-unique');

    // If HomeKit already knows this accessory from a previous run, attach
    // the handler before station resolution: HomeKit is already presenting
    // the old readings, so staleness must be tracked even while discovery
    // keeps failing. On a first run there is nothing in HomeKit to go
    // stale, and the accessory is only created after discovery succeeds.
    const restored = this.accessories.get(uuid);
    if (restored && !this.handler) {
      this.log.info('Restoring NOAA Weather accessory from cache.');
      this.handler = new NOAAWeatherAccessory(this, restored, PLUGIN_VERSION);
    }

    let stationId = cfg.stationId;
    let initialObservation: ParsedObservation | null = null;
    if (stationId) {
      this.log.info(`Using manually configured NOAA station: ${stationId}`);
    } else {
      const cached = readStationCache(this.log, cacheFile, cfg.latitude, cfg.longitude);
      if (cached.wasCorrupted) {
        this.stationCacheResets++;
      }
      stationId = cached.stationId;
    }

    if (!stationId) {
      const selection = await this.discoverStation(cfg.latitude, cfg.longitude, cacheFile);
      if (this.shuttingDown) {
        return;
      }
      if (!selection) {
        // Same clock as failed polls: readings restored from a previous
        // run go inactive once they age past the staleness threshold.
        this.handler?.noteObservationFailure();
        this.scheduleDiscoveryRetry();
        return;
      }
      stationId = selection.stationId;
      initialObservation = selection.observation;
    }

    let accessory = this.accessories.get(uuid);
    if (!accessory) {
      accessory = new this.api.platformAccessory('NOAA Weather', uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(uuid, accessory);
      this.log.info('Created new NOAA Weather accessory.');
    }

    if (!this.handler) {
      this.handler = new NOAAWeatherAccessory(this, accessory, PLUGIN_VERSION);
    }
    const autoStation = cfg.stationId === null
      ? { latitude: cfg.latitude, longitude: cfg.longitude, cacheFile }
      : undefined;
    this.startPolling(
      stationId,
      this.handler,
      cfg.baseRefreshMs,
      cfg.adaptivePolling,
      autoStation,
      initialObservation,
    );

    for (const [cachedUuid, cached] of this.accessories) {
      if (cachedUuid !== uuid) {
        this.log.info('Removing stale accessory from cache:', cached.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [cached]);
        this.accessories.delete(cachedUuid);
      }
    }
  }

  /**
   * Station discovery commonly fails at boot when Homebridge starts before
   * the network is fully up (a Pi and its router rebooting together after a
   * power outage). The HTTP client's internal retries only span about a
   * minute, so instead of staying dead until a manual restart, re-run
   * discovery on a doubling backoff, forever. The timer is unref()'d and
   * tracked in this.timers so it never blocks or survives shutdown.
   */
  private scheduleDiscoveryRetry(reason = 'Station discovery failed'): void {
    if (this.shuttingDown) {
      return;
    }
    const delayMs = withJitter(this.discoveryRetryMs);
    this.discoveryRetryMs = Math.min(this.discoveryRetryMs * 2, DISCOVERY_RETRY_MAX_MS);
    this.log.warn(`${reason}; retrying in ${Math.round(delayMs / 1000)}s.`);
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.discoverDevices().catch((err) => {
        this.log.error('Unhandled error in discovery retry:', err);
      });
    }, delayMs);
    t.unref();
    this.timers.add(t);
  }

  private async discoverStation(
    latitude: number,
    longitude: number,
    cacheFile: string,
    excludeStationId?: string,
  ): Promise<StationSelection | null> {
    try {
      // The coordinates themselves are deliberately kept out of the log:
      // Homebridge logs get pasted into public bug reports.
      this.log.info('Fetching NOAA grid data for the configured coordinates.');

      const point = await this.client.fetchJson<PointResponse>(
        `${NWS_API_BASE}/points/${encodeURIComponent(`${latitude},${longitude}`)}`,
      );
      const props =
        point && typeof point === 'object' &&
        point.properties && typeof point.properties === 'object'
          ? point.properties
          : {};
      const gridId = props.gridId;
      const gridX = props.gridX;
      const gridY = props.gridY;

      if (
        typeof gridId !== 'string' || !GRID_ID_RE.test(gridId) ||
        !Number.isInteger(gridX) || !Number.isInteger(gridY) ||
        (gridX as number) < 0 || (gridY as number) < 0
      ) {
        this.log.error('Invalid /points response for the configured coordinates.');
        return null;
      }

      this.log.info(`Grid location: ${gridId}/${gridX},${gridY}`);

      const stations = await this.client.fetchJson<GridpointStationsResponse>(
        `${NWS_API_BASE}/gridpoints/${encodeURIComponent(gridId)}/${gridX},${gridY}/stations`,
      );

      const features = Array.isArray(stations?.features) ? stations.features : [];
      const candidates = [...new Set(features
        .map((f) => f?.properties?.stationIdentifier)
        .filter((id): id is string => typeof id === 'string' && STATION_ID_RE.test(id)))]
        .filter((id) => id !== excludeStationId)
        .slice(0, MAX_STATION_CANDIDATES);

      if (candidates.length === 0) {
        this.log.error('No valid NOAA stations found for grid cell.');
        return null;
      }
      this.log.info(`Station candidates: ${candidates.join(', ')}`);

      let selection: StationSelection | null = null;
      for (const candidate of candidates) {
        if (this.shuttingDown) {
          return null;
        }
        try {
          const observation = await this.fetchObservation(candidate);
          if (!isObservationFresh(observation)) {
            this.log.warn(`Skipping NOAA station ${candidate}: latest observation is stale.`);
            continue;
          }
          selection = { stationId: candidate, observation };
          break;
        } catch (err) {
          if (!isStationUnavailable(err)) {
            throw err;
          }
          this.log.warn(`Skipping NOAA station ${candidate}: no usable observation.`);
        }
      }

      if (!selection) {
        this.log.error(
          `No station among the nearest ${candidates.length} candidates has a fresh observation.`,
        );
        return null;
      }
      this.log.info(`Selected NOAA station: ${selection.stationId}`);

      const cache: PointsCache = {
        latitude,
        longitude,
        gridId,
        gridX: gridX as number,
        gridY: gridY as number,
        stationId: selection.stationId,
        timestamp: Date.now(),
      };
      writeJsonAtomic(this.log, cacheFile, cache);

      return selection;
    } catch (err) {
      if (!this.shuttingDown) {
        this.log.error('Failed to discover NOAA station:', (err as Error).message);
      }
      return null;
    }
  }

  /**
   * Hand the accessory to an ObservationPoller. Only one poller may exist:
   * a second timer chain's first colliding tick would hit the in-flight
   * guard and die without rescheduling — a silent landmine for future
   * refactors, so the invariant is enforced here rather than assumed.
   */
  private startPolling(
    stationId: string,
    handler: NOAAWeatherAccessory,
    baseRefreshMs: number,
    adaptive: boolean,
    autoStation?: AutoStationContext,
    initialObservation: ParsedObservation | null = null,
  ): void {
    if (this.shuttingDown) {
      return;
    }
    if (this.poller) {
      this.log.debug('startPolling called again; ignoring (already polling).');
      return;
    }
    this.poller = new ObservationPoller({
      stationId,
      sink: handler,
      baseRefreshMs,
      adaptive,
      log: this.log,
      initialObservation,
      fetchObservation: (id) => this.fetchObservation(id),
      findReplacement: autoStation
        ? (exclude) => this.discoverStation(
          autoStation.latitude, autoStation.longitude, autoStation.cacheFile, exclude,
        )
        : undefined,
    });
    this.poller.start();
  }

  private async fetchObservation(stationId: string): Promise<ParsedObservation> {
    const data = await this.client.fetchJson<ObservationResponse>(
      `${NWS_API_BASE}/stations/${encodeURIComponent(stationId)}/observations/latest`,
    );

    const props =
      data && typeof data === 'object' &&
      data.properties && typeof data.properties === 'object'
        ? data.properties
        : {};
    const tempC = this.extractTemperatureC(props.temperature);
    const humidity = this.extractHumidity(props.relativeHumidity);
    const weather = Array.isArray(props.presentWeather) ? props.presentWeather : [];
    const conditions =
      weather
        .map((w) => w && typeof w === 'object' ? (w as { weather?: unknown }).weather : undefined)
        .filter((value): value is string => typeof value === 'string')
        .join(', ') || 'None';

    // Routine polls log at debug; applyReading logs at info when values
    // change. Free-text fields from the API body are sanitized first.
    this.log.debug(
      `NOAA - ts=${sanitizeForLog(props.timestamp ?? 'n/a')} temp=${tempC ?? 'n/a'}°C ` +
      `humidity=${humidity ?? 'n/a'}% conditions=${sanitizeForLog(conditions, 120)}`,
    );

    const observedMs = typeof props.timestamp === 'string' ? Date.parse(props.timestamp) : NaN;
    if (tempC === null && humidity === null) {
      throw new UnusableObservationError('NOAA observation contained no usable measurements');
    }
    return {
      temperature: tempC,
      humidity,
      observedAt: Number.isFinite(observedMs) ? observedMs : null,
    };
  }

  /**
   * Shared validation for an NWS QuantitativeValue. Returns the numeric
   * value only when it is a finite number that passed (or was not subject
   * to) MADIS quality control.
   *
   * TypeScript describes the expected schema, but JSON.parse enforces no
   * runtime types and can decode an overflowing number (such as 1e400) as
   * Infinity. Reject before conversion so a malformed API value cannot
   * become a plausible-looking clamped HomeKit reading.
   */
  private acceptedValue(qv: QuantitativeValue | undefined, label: string): number | null {
    if (!qv || typeof qv.value !== 'number' || !Number.isFinite(qv.value)) {
      return null;
    }
    if (
      qv.qualityControl !== undefined && qv.qualityControl !== null &&
      (typeof qv.qualityControl !== 'string' || !ACCEPTABLE_QC.has(qv.qualityControl))
    ) {
      this.log.debug(`Rejecting ${label} with QC=${sanitizeForLog(qv.qualityControl, 8)}`);
      return null;
    }
    return qv.value;
  }

  /** Convert NWS QuantitativeValue to °C, honoring unitCode and QC flag. */
  private extractTemperatureC(qv: QuantitativeValue | undefined): number | null {
    const value = this.acceptedValue(qv, 'temperature');
    if (value === null) {
      return null;
    }
    const unitCode = qv?.unitCode;
    if (unitCode !== undefined && unitCode !== null && typeof unitCode !== 'string') {
      this.log.warn('Temperature unit is not a string; ignoring reading.');
      return null;
    }
    const unit = (unitCode ?? '').toLowerCase();
    if (unit === '') {
      // NWS always sends wmoUnit:degC in practice; a missing unitCode is a
      // station anomaly. Assume Celsius but leave a trace (once) so a
      // misbehaving station is diagnosable rather than invisible.
      if (!this.assumedCelsiusLogged) {
        this.assumedCelsiusLogged = true;
        this.log.debug('Temperature reading has no unitCode; assuming Celsius.');
      }
      return value;
    }
    if (unit.endsWith('degc')) {
      return value;
    }
    if (unit.endsWith('degf')) {
      return (value - 32) * (5 / 9);
    }
    if (unit.endsWith('k')) {
      return value - 273.15;
    }
    this.log.warn(`Unknown temperature unit "${sanitizeForLog(unitCode, 32)}", ignoring reading.`);
    return null;
  }

  private extractHumidity(qv: QuantitativeValue | undefined): number | null {
    const value = this.acceptedValue(qv, 'humidity');
    return value === null ? null : Math.max(0, Math.min(100, value));
  }

  /**
   * Hourly operational summary. Client counters cover the transport; the
   * poller fields answer the questions a user with stale sensors actually
   * asks — which station is feeding me, has it been switched, and when did
   * a reading last reach HomeKit.
   */
  private logMetrics(): void {
    const m = this.client.metrics;
    const p = this.poller?.metrics;
    const lastSuccess = p?.lastSuccessAt ? new Date(p.lastSuccessAt).toISOString() : 'never';
    this.log.info(
      `NOAA Platform Metrics - failures=${m.apiFailures} ` +
      `retries=${m.retryCount} rateLimited=${m.rateLimitedCount} ` +
      `cacheResets=${this.stationCacheResets} ` +
      `station=${p?.activeStationId ?? 'none'} failovers=${p?.stationFailovers ?? 0} ` +
      `lastSuccess=${lastSuccess}`,
    );
  }
}
