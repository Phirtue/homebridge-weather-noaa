import type { Logging } from 'homebridge';
import * as fs from 'fs';

/** Station IDs are 3-8 uppercase alphanumerics (e.g. KSEA, KPAE). */
export const STATION_ID_RE = /^[A-Z0-9]{3,8}$/;

const STATION_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Station/grid metadata persisted between restarts to skip re-discovery. */
export interface PointsCache {
  latitude: number;
  longitude: number;
  gridId: string;
  gridX: number;
  gridY: number;
  stationId: string;
  timestamp: number;
}

export interface StationCacheResult {
  stationId: string | null;
  /** True when an unreadable cache file was found and deleted. */
  wasCorrupted: boolean;
}

/**
 * Write JSON to disk atomically (temp file + rename) with owner-only
 * permissions. Failures are logged, never thrown — a broken cache must not
 * take the plugin down.
 */
export function writeJsonAtomic(log: Logging, file: string, data: unknown): void {
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
    log.warn(`Failed to persist ${file}: ${(err as Error).message}`);
  }
}

/**
 * Load the cached station for the given coordinates. The cached station ID
 * is re-validated against STATION_ID_RE before use, so a tampered cache file
 * can never inject content into a request URL.
 */
export function readStationCache(
  log: Logging,
  cacheFile: string,
  latitude: number,
  longitude: number,
): StationCacheResult {
  if (!fs.existsSync(cacheFile)) {
    return { stationId: null, wasCorrupted: false };
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
      return { stationId: null, wasCorrupted: false };
    }

    const gridNote =
      cache.gridId && Number.isFinite(cache.gridX) && Number.isFinite(cache.gridY)
        ? ` (grid ${cache.gridId}/${cache.gridX},${cache.gridY})`
        : '';
    log.info(`Using cached NOAA station: ${cache.stationId}${gridNote}`);
    return { stationId: cache.stationId, wasCorrupted: false };
  } catch {
    log.warn('Corrupted NOAA station cache. Rebuilding.');
    try {
      fs.unlinkSync(cacheFile);
    } catch {
      /* ignore */
    }
    return { stationId: null, wasCorrupted: true };
  }
}
