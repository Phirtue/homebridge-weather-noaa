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
import { PLATFORM_NAME, PLUGIN_NAME, PLUGIN_VERSION } from './settings.js';
import { readStationCache, writeJsonAtomic, STATION_ID_RE, PointsCache } from './stationCache.js';

const GRID_ID_RE = /^[A-Z]{2,4}$/;

/**
 * The NWS API expects coordinates with at most 4 decimal places; anything
 * more precise gets a 301 redirect. Rounding client-side saves that round
 * trip and keeps the station cache key stable.
 */
const COORD_DECIMALS = 4;

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

const ADAPTIVE_GROW_AFTER_UNCHANGED = 3;
const ADAPTIVE_MAX_MULT = 4;

/**
 * Backoff schedule for retrying station discovery after a startup failure
 * (e.g. Homebridge boots before the WAN link is up). Doubles from 1 minute
 * to a 15 minute ceiling and retries indefinitely.
 */
const DISCOVERY_RETRY_INITIAL_MS = 60_000;
const DISCOVERY_RETRY_MAX_MS = 15 * 60_000;

/** Validated plugin configuration; null when required fields are unusable. */
interface PluginConfig {
  latitude: number;
  longitude: number;
  baseRefreshMs: number;
  adaptivePolling: boolean;
  stationId: string | null;
  userAgentContact: string | null;
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
  value: number | null;
  unitCode?: string;
  qualityControl?: string;
}

interface ObservationResponse {
  properties?: {
    timestamp?: string;
    temperature?: QuantitativeValue;
    relativeHumidity?: QuantitativeValue;
    presentWeather?: Array<{ weather?: string }>;
  };
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

    const refreshMinutes = Math.max(5, toNumber(raw.refreshInterval) ?? 15);

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
          `Configured stationId "${raw.stationId}" is invalid (expected 3-8 alphanumerics). ` +
          'Falling back to auto-discovery.',
        );
      }
    }

    const userAgentContact =
      typeof raw.userAgentContact === 'string' && raw.userAgentContact.trim().length > 0
        ? raw.userAgentContact
        : null;

    const round = (v: number): number => Number(v.toFixed(COORD_DECIMALS));

    return {
      latitude: round(latitude),
      longitude: round(longitude),
      baseRefreshMs: refreshMinutes * 60 * 1000,
      adaptivePolling,
      stationId,
      userAgentContact,
    };
  }

  /**
   * NWS-recommended User-Agent format: "(myapp.com, contact)".
   * https://www.weather.gov/documentation/services-web-api
   *
   * The optional contact field is sanitized to strip CR/LF, preventing
   * HTTP header injection from a misconfigured config.json value.
   */
  private buildUserAgent(): string {
    const contactRaw = (this.config as Record<string, unknown>).userAgentContact;
    const home = 'github.com/Phirtue/homebridge-weather-noaa';
    if (typeof contactRaw === 'string' && contactRaw.trim().length > 0) {
      const clean = contactRaw.trim().replace(/[\r\n]/g, '').slice(0, 200);
      return `homebridge-weather-noaa/${PLUGIN_VERSION} (${home}, ${clean})`;
    }
    return `homebridge-weather-noaa/${PLUGIN_VERSION} (${home})`;
  }

  private async discoverDevices(): Promise<void> {
    const cfg = this.parseConfig();
    if (!cfg) {
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
      stationId = await this.discoverStation(cfg.latitude, cfg.longitude, cacheFile);
      if (!stationId) {
        // Same clock as failed polls: readings restored from a previous
        // run go inactive once they age past the staleness threshold.
        this.handler?.noteObservationFailure();
        this.scheduleDiscoveryRetry();
        return;
      }
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
    this.startPolling(stationId, this.handler, cfg.baseRefreshMs, cfg.adaptivePolling);

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
  private scheduleDiscoveryRetry(): void {
    const delayMs = withJitter(this.discoveryRetryMs);
    this.discoveryRetryMs = Math.min(this.discoveryRetryMs * 2, DISCOVERY_RETRY_MAX_MS);
    this.log.warn(
      `Station discovery failed; retrying in ${Math.round(delayMs / 1000)}s.`,
    );
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
  ): Promise<string | null> {
    try {
      this.log.info(`Fetching NOAA grid data for: ${latitude},${longitude}`);

      const point = await this.client.fetchJson<PointResponse>(
        `${NWS_API_BASE}/points/${encodeURIComponent(`${latitude},${longitude}`)}`,
      );
      const props = point.properties ?? {};
      const gridId = props.gridId;
      const gridX = props.gridX;
      const gridY = props.gridY;

      if (
        typeof gridId !== 'string' || !GRID_ID_RE.test(gridId) ||
        !Number.isInteger(gridX) || !Number.isInteger(gridY) ||
        (gridX as number) < 0 || (gridY as number) < 0
      ) {
        this.log.error(`Invalid /points response for ${latitude},${longitude}`);
        return null;
      }

      this.log.info(`Grid location: ${gridId}/${gridX},${gridY}`);

      const stations = await this.client.fetchJson<GridpointStationsResponse>(
        `${NWS_API_BASE}/gridpoints/${encodeURIComponent(gridId)}/${gridX},${gridY}/stations`,
      );

      const candidates = (stations.features ?? [])
        .map((f) => f?.properties?.stationIdentifier)
        .filter((id): id is string => typeof id === 'string' && STATION_ID_RE.test(id));

      if (candidates.length === 0) {
        this.log.error('No valid NOAA stations found for grid cell.');
        return null;
      }

      const stationId = candidates[0];
      this.log.info(`Station candidates: ${candidates.slice(0, 10).join(', ')}`);
      this.log.info(`Selected NOAA station: ${stationId}`);

      const cache: PointsCache = {
        latitude,
        longitude,
        gridId,
        gridX: gridX as number,
        gridY: gridY as number,
        stationId,
        timestamp: Date.now(),
      };
      writeJsonAtomic(this.log, cacheFile, cache);

      return stationId;
    } catch (err) {
      this.log.error('Failed to discover NOAA station:', (err as Error).message);
      return null;
    }
  }

  private startPolling(
    stationId: string,
    handler: NOAAWeatherAccessory,
    baseRefreshMs: number,
    adaptive: boolean,
  ): void {
    let unchangedStreak = 0;
    let inFlight = false;

    const scheduleNext = (): void => {
      let mult = 1;
      if (adaptive && unchangedStreak >= ADAPTIVE_GROW_AFTER_UNCHANGED) {
        mult = Math.min(
          ADAPTIVE_MAX_MULT,
          1 + Math.floor(unchangedStreak / ADAPTIVE_GROW_AFTER_UNCHANGED),
        );
      }
      const delay = withJitter(baseRefreshMs * mult);
      const t = setTimeout(() => {
        this.timers.delete(t);
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        tick().catch((err) => this.log.error('Tick error:', err));
      }, delay);
      t.unref();
      this.timers.add(t);
    };

    const tick = async (): Promise<void> => {
      if (inFlight) {
        return;
      }
      inFlight = true;
      try {
        const changed = await this.fetchAndPushObservation(stationId, handler);
        unchangedStreak = changed ? 0 : unchangedStreak + 1;
      } catch (err) {
        this.log.error('NOAA observation fetch failed:', (err as Error).message);
        unchangedStreak = 0;
        // Failed polls never reach applyReading, so staleness must be
        // re-evaluated here or an extended outage leaves sensors active.
        handler.noteObservationFailure();
      } finally {
        inFlight = false;
        scheduleNext();
      }
    };

    tick().catch((err) => this.log.error('Initial tick error:', err));
  }

  private async fetchAndPushObservation(
    stationId: string,
    handler: NOAAWeatherAccessory,
  ): Promise<boolean> {
    const data = await this.client.fetchJson<ObservationResponse>(
      `${NWS_API_BASE}/stations/${encodeURIComponent(stationId)}/observations/latest`,
    );

    const props = data.properties ?? {};
    const tempC = this.extractTemperatureC(props.temperature);
    const humidity = this.extractHumidity(props.relativeHumidity);
    const conditions =
      props.presentWeather?.map((w) => w?.weather).filter(Boolean).join(', ') || 'None';

    // Routine polls log at debug; applyReading logs at info when values change.
    this.log.debug(
      `NOAA - ts=${props.timestamp ?? 'n/a'} temp=${tempC ?? 'n/a'}°C ` +
      `humidity=${humidity ?? 'n/a'}% conditions=${conditions}`,
    );

    const observedMs = props.timestamp ? Date.parse(props.timestamp) : NaN;
    return handler.applyReading({
      temperature: tempC,
      humidity,
      observedAt: Number.isFinite(observedMs) ? observedMs : null,
    });
  }

  /** Convert NWS QuantitativeValue to °C, honoring unitCode and QC flag. */
  private extractTemperatureC(qv: QuantitativeValue | undefined): number | null {
    if (!qv || qv.value === null || qv.value === undefined) {
      return null;
    }
    if (qv.qualityControl && !ACCEPTABLE_QC.has(qv.qualityControl)) {
      this.log.debug(`Rejecting temperature with QC=${qv.qualityControl}`);
      return null;
    }
    const unit = (qv.unitCode ?? '').toLowerCase();
    if (unit === '') {
      // NWS always sends wmoUnit:degC in practice; a missing unitCode is a
      // station anomaly. Assume Celsius but leave a trace (once) so a
      // misbehaving station is diagnosable rather than invisible.
      if (!this.assumedCelsiusLogged) {
        this.assumedCelsiusLogged = true;
        this.log.debug('Temperature reading has no unitCode; assuming Celsius.');
      }
      return qv.value;
    }
    if (unit.endsWith('degc')) {
      return qv.value;
    }
    if (unit.endsWith('degf')) {
      return (qv.value - 32) * (5 / 9);
    }
    if (unit.endsWith('k')) {
      return qv.value - 273.15;
    }
    this.log.warn(`Unknown temperature unit "${qv.unitCode}", ignoring reading.`);
    return null;
  }

  private extractHumidity(qv: QuantitativeValue | undefined): number | null {
    if (!qv || qv.value === null || qv.value === undefined) {
      return null;
    }
    if (qv.qualityControl && !ACCEPTABLE_QC.has(qv.qualityControl)) {
      this.log.debug(`Rejecting humidity with QC=${qv.qualityControl}`);
      return null;
    }
    return Math.max(0, Math.min(100, qv.value));
  }

  private logMetrics(): void {
    const m = this.client.metrics;
    this.log.info(
      `NOAA Platform Metrics - failures=${m.apiFailures} ` +
      `retries=${m.retryCount} rateLimited=${m.rateLimitedCount} ` +
      `cacheResets=${this.stationCacheResets}`,
    );
  }
}
