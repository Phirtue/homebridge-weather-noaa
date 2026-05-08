import {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';
import * as fs from 'fs';
import * as path from 'path';

import { NOAAWeatherAccessory } from './platformAccessory';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';

const PLUGIN_VERSION = '1.6.0';

const NOAA_BASE = 'https://api.weather.gov';
const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_BYTE_CAP = 2_000_000;
const STATION_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const STATION_ID_RE = /^[A-Z0-9]{3,8}$/;
const GRID_ID_RE = /^[A-Z]{2,4}$/;

/**
 * NWS rate-limit guidance: requests "may be retried after the limit clears
 * (typically within 5 seconds)". We anchor backoff floor accordingly.
 * https://www.weather.gov/documentation/services-web-api
 */
const RATE_LIMIT_FLOOR_MS = 5_000;
const BACKOFF_CEILING_MS = 60_000;
const RETRY_AFTER_CAP_MS = 5 * 60_000;
const MAX_RETRIES = 4;

/**
 * MADIS QC flags treated as acceptable for HomeKit display:
 *   V = passed all QC checks (best)
 *   C = passed coarse QC checks
 *   S = passed spatial QC checks
 *   Z = no QC performed (raw — many ASOS/AWOS sites report this)
 * Rejected: X (failed), Q (questionable), B (subjective bad).
 * https://madis.ncep.noaa.gov/madis_sfc_qc_notes.shtml
 */
const ACCEPTABLE_QC = new Set(['V', 'C', 'S', 'Z']);

const ADAPTIVE_GROW_AFTER_UNCHANGED = 3;
const ADAPTIVE_MAX_MULT = 4;

interface PointsCache {
  latitude: number;
  longitude: number;
  gridId: string;
  gridX: number;
  gridY: number;
  stationId: string;
  timestamp: number;
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

  private readonly userAgent: string;
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly metrics = {
    apiFailures: 0,
    retryCount: 0,
    rateLimitedCount: 0,
    stationCacheResets: 0,
  };

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.userAgent = this.buildUserAgent();

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

  private getNumberConfig(key: string): number | undefined {
    const raw = (this.config as Record<string, unknown>)[key];
    if (raw === null || raw === undefined || raw === '') {
      return undefined;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }

  private getBoolConfig(key: string, fallback: boolean): boolean {
    const raw = (this.config as Record<string, unknown>)[key];
    if (typeof raw === 'boolean') {
      return raw;
    }
    if (typeof raw === 'string') {
      return raw.toLowerCase() === 'true';
    }
    return fallback;
  }

  private getStationIdConfig(): string | null {
    const raw = (this.config as Record<string, unknown>).stationId;
    if (typeof raw !== 'string' || raw.length === 0) {
      return null;
    }
    const upper = raw.trim().toUpperCase();
    if (!STATION_ID_RE.test(upper)) {
      this.log.warn(
        `Configured stationId "${raw}" is invalid (expected 3-8 alphanumerics). ` +
        'Falling back to auto-discovery.',
      );
      return null;
    }
    return upper;
  }

  /**
   * Fetch JSON from the NWS API with bounded retries and rate-limit handling.
   * Native fetch + AbortController; no third-party HTTP client required.
   */
  private async fetchJson<T>(url: string): Promise<T> {
    let attempt = 0;
    let backoffMs = RATE_LIMIT_FLOOR_MS;

    while (attempt <= MAX_RETRIES) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent': this.userAgent,
            'Accept': 'application/geo+json, application/ld+json, application/json',
          },
          signal: ac.signal,
          redirect: 'follow',
        });

        if (res.ok) {
          const text = await res.text();
          if (text.length > RESPONSE_BYTE_CAP) {
            throw new Error(`Response exceeded ${RESPONSE_BYTE_CAP} bytes (${text.length})`);
          }
          return JSON.parse(text) as T;
        }

        if (res.status === 429) {
          this.metrics.rateLimitedCount++;
          const waitMs = this.parseRetryAfter(res.headers.get('retry-after'), backoffMs);
          this.log.warn(`NOAA rate-limited (429). Waiting ${(waitMs / 1000).toFixed(1)}s.`);
          await this.sleep(waitMs);
          backoffMs = Math.min(backoffMs * 2, BACKOFF_CEILING_MS);
          attempt++;
          this.metrics.retryCount++;
          continue;
        }

        if (res.status >= 500 && res.status <= 599) {
          this.metrics.retryCount++;
          this.log.warn(
            `NOAA ${res.status}; retrying in ${(backoffMs / 1000).toFixed(1)}s.`,
          );
          await this.sleep(backoffMs);
          backoffMs = Math.min(backoffMs * 2, BACKOFF_CEILING_MS);
          attempt++;
          continue;
        }

        this.metrics.apiFailures++;
        throw new Error(`NOAA API ${res.status} ${res.statusText} for ${url}`);
      } catch (err) {
        const isAbort = (err as { name?: string })?.name === 'AbortError';
        const code = (err as { code?: string })?.code;
        const isNetwork =
          isAbort ||
          code === 'ENOTFOUND' || code === 'ECONNRESET' ||
          code === 'ECONNREFUSED' || code === 'ETIMEDOUT' ||
          (err instanceof TypeError && /fetch failed/i.test(err.message));

        if (isNetwork && attempt < MAX_RETRIES) {
          this.metrics.retryCount++;
          this.log.warn(
            `Network error (${isAbort ? 'timeout' : (err as Error).message}); ` +
            `retrying in ${(backoffMs / 1000).toFixed(1)}s.`,
          );
          await this.sleep(backoffMs);
          backoffMs = Math.min(backoffMs * 2, BACKOFF_CEILING_MS);
          attempt++;
          continue;
        }

        this.metrics.apiFailures++;
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }

    throw new Error(`NOAA API: exhausted ${MAX_RETRIES} retries for ${url}`);
  }

  private parseRetryAfter(header: string | null, fallbackMs: number): number {
    if (!header) {
      return fallbackMs;
    }
    const asInt = Number(header);
    if (Number.isFinite(asInt) && asInt >= 0) {
      return Math.min(Math.max(asInt * 1000, RATE_LIMIT_FLOOR_MS), RETRY_AFTER_CAP_MS);
    }
    const asDate = Date.parse(header);
    if (!Number.isNaN(asDate)) {
      const delta = asDate - Date.now();
      if (delta > 0) {
        return Math.min(Math.max(delta, RATE_LIMIT_FLOOR_MS), RETRY_AFTER_CAP_MS);
      }
    }
    return fallbackMs;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms));
  }

  private writeCacheAtomic(file: string, data: PointsCache): void {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      this.log.warn(`Failed to persist station cache: ${(err as Error).message}`);
    }
  }

  private readStationCache(
    cacheFile: string,
    latitude: number,
    longitude: number,
  ): string | null {
    if (!fs.existsSync(cacheFile)) {
      return null;
    }
    try {
      const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as PointsCache;
      const ageMs = Date.now() - cache.timestamp;
      const valid =
        typeof cache.stationId === 'string' &&
        STATION_ID_RE.test(cache.stationId) &&
        cache.latitude === latitude &&
        cache.longitude === longitude &&
        Number.isFinite(cache.timestamp) &&
        ageMs >= 0 &&
        ageMs < STATION_CACHE_TTL_MS;

      if (!valid) {
        return null;
      }

      const gridNote =
        cache.gridId && Number.isFinite(cache.gridX) && Number.isFinite(cache.gridY)
          ? ` (grid ${cache.gridId}/${cache.gridX},${cache.gridY})`
          : '';
      this.log.info(`Using cached NOAA station: ${cache.stationId}${gridNote}`);
      return cache.stationId;
    } catch {
      this.metrics.stationCacheResets++;
      this.log.warn('Corrupted NOAA station cache. Rebuilding.');
      try {
        fs.unlinkSync(cacheFile);
      } catch {
        /* ignore */
      }
      return null;
    }
  }

  private async discoverDevices(): Promise<void> {
    const latitude = this.getNumberConfig('latitude');
    const longitude = this.getNumberConfig('longitude');
    const refreshMinutes = Math.max(5, this.getNumberConfig('refreshInterval') ?? 15);
    const baseRefreshMs = refreshMinutes * 60 * 1000;
    const adaptive = this.getBoolConfig('adaptivePolling', true);
    const cacheFile = path.join(this.api.user.persistPath(), 'noaa-points-cache.json');

    if (
      latitude === undefined || longitude === undefined ||
      latitude < -90 || latitude > 90 ||
      longitude < -180 || longitude > 180
    ) {
      this.log.error('Latitude and Longitude must be valid numbers within range. Plugin will not start.');
      return;
    }

    let stationId = this.getStationIdConfig();
    if (stationId) {
      this.log.info(`Using manually configured NOAA station: ${stationId}`);
    } else {
      stationId = this.readStationCache(cacheFile, latitude, longitude);
    }

    if (!stationId) {
      stationId = await this.discoverStation(latitude, longitude, cacheFile);
      if (!stationId) {
        return;
      }
    }

    // Stable UUID — preserved from v1.5 so existing HomeKit room assignments
    // and automations survive the upgrade.
    const uuid = this.api.hap.uuid.generate('noaa-weather-unique');
    let accessory = this.accessories.get(uuid);

    if (accessory) {
      this.log.info('Restoring NOAA Weather accessory from cache.');
    } else {
      accessory = new this.api.platformAccessory('NOAA Weather', uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(uuid, accessory);
      this.log.info('Created new NOAA Weather accessory.');
    }

    const handler = new NOAAWeatherAccessory(this, accessory, PLUGIN_VERSION);
    this.startPolling(stationId, handler, baseRefreshMs, adaptive);

    for (const [cachedUuid, cached] of this.accessories) {
      if (cachedUuid !== uuid) {
        this.log.info('Removing stale accessory from cache:', cached.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [cached]);
        this.accessories.delete(cachedUuid);
      }
    }
  }

  private async discoverStation(
    latitude: number,
    longitude: number,
    cacheFile: string,
  ): Promise<string | null> {
    try {
      this.log.info(`Fetching NOAA grid data for: ${latitude},${longitude}`);

      const point = await this.fetchJson<PointResponse>(
        `${NOAA_BASE}/points/${encodeURIComponent(`${latitude},${longitude}`)}`,
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

      const stations = await this.fetchJson<GridpointStationsResponse>(
        `${NOAA_BASE}/gridpoints/${encodeURIComponent(gridId)}/${gridX},${gridY}/stations`,
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

      this.writeCacheAtomic(cacheFile, {
        latitude,
        longitude,
        gridId,
        gridX: gridX as number,
        gridY: gridY as number,
        stationId,
        timestamp: Date.now(),
      });

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
      const delay = baseRefreshMs * mult;
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
    const data = await this.fetchJson<ObservationResponse>(
      `${NOAA_BASE}/stations/${encodeURIComponent(stationId)}/observations/latest`,
    );

    const props = data.properties ?? {};
    const tempC = this.extractTemperatureC(props.temperature);
    const humidity = this.extractHumidity(props.relativeHumidity);
    const conditions =
      props.presentWeather?.map((w) => w?.weather).filter(Boolean).join(', ') || 'None';

    this.log.info(
      `NOAA - ts=${props.timestamp ?? 'n/a'} temp=${tempC ?? 'n/a'}°C ` +
      `humidity=${humidity ?? 'n/a'}% conditions=${conditions}`,
    );

    return handler.applyReading({ temperature: tempC, humidity });
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
    if (unit.endsWith('degc') || unit === '') {
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
    this.log.info(
      `NOAA Platform Metrics - failures=${this.metrics.apiFailures} ` +
      `retries=${this.metrics.retryCount} rateLimited=${this.metrics.rateLimitedCount} ` +
      `cacheResets=${this.metrics.stationCacheResets}`,
    );
  }
}
