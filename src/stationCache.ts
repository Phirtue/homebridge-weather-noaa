import type { Logging } from 'homebridge';
import * as fs from 'fs';

/** Station IDs are 3-8 uppercase alphanumerics (e.g. KSEA, KPAE). */
export const STATION_ID_RE = /^[A-Z0-9]{3,8}$/;

/** NWS forecast office / grid IDs are 2-4 uppercase letters (e.g. SEW). */
export const GRID_ID_RE = /^[A-Z]{2,4}$/;

const STATION_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Upper bound for either cache file. Real files are under 200 bytes; a
 * file past this size is damaged or planted and is treated as corrupt
 * rather than parsed.
 */
export const CACHE_MAX_BYTES = 64 * 1024;

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
 * permissions. The temp file is opened with `wx` (exclusive create): if
 * something already sits at that path — a stale temp file, or a symlink
 * planted to redirect the write elsewhere — the open fails instead of
 * following it. Failures are logged, never thrown — a broken cache must
 * not take the plugin down.
 */
export function writeJsonAtomic(log: Logging, file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
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
 * Read and parse a cache file. The plugin only ever writes small regular
 * files here, so anything else at the path is damaged or planted and is
 * rejected before it is read:
 *  - symlinks are not followed (O_NOFOLLOW), so the file cannot be pointed
 *    at something outside the persist directory;
 *  - non-regular files (a FIFO or device such as /dev/zero) are refused,
 *    and O_NONBLOCK keeps the open itself from hanging on a FIFO;
 *  - size is checked on the open descriptor (no check-then-read race) and
 *    capped at CACHE_MAX_BYTES so a huge file is never read into memory.
 * Throws on any problem; callers treat every throw as "corrupt".
 */
export function readJsonBounded(file: string): unknown {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  const fd = fs.openSync(file, O_RDONLY | (O_NOFOLLOW ?? 0) | (O_NONBLOCK ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error('cache path is not a regular file');
    }
    if (stat.size > CACHE_MAX_BYTES) {
      throw new Error(`cache file is ${stat.size} bytes; cap is ${CACHE_MAX_BYTES}`);
    }
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally {
    fs.closeSync(fd);
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
    const cache = readJsonBounded(cacheFile) as PointsCache;
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

    // Grid fields are informational only, but they still come from a file
    // on disk: validate before they touch the log.
    const gridNote =
      typeof cache.gridId === 'string' && GRID_ID_RE.test(cache.gridId) &&
      Number.isFinite(cache.gridX) && Number.isFinite(cache.gridY)
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
