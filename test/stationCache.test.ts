import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readStationCache, writeJsonAtomic, CACHE_MAX_BYTES, GRID_ID_RE, STATION_ID_RE, PointsCache,
} from '../src/stationCache.js';
import { makeFakeLog } from './helpers.js';

const LAT = 47.6204;
const LON = -122.3494;

function validCache(overrides: Partial<PointsCache> = {}): PointsCache {
  return {
    latitude: LAT,
    longitude: LON,
    gridId: 'SEW',
    gridX: 125,
    gridY: 68,
    stationId: 'KSEA',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('station cache', () => {
  let dir: string;
  let file: string;
  const log = makeFakeLog();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noaa-test-'));
    file = path.join(dir, 'points-cache.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a valid cache', () => {
    writeJsonAtomic(log, file, validCache());
    const result = readStationCache(log, file, LAT, LON);
    expect(result).toEqual({ stationId: 'KSEA', wasCorrupted: false });
  });

  it('writes with owner-only permissions', () => {
    writeJsonAtomic(log, file, validCache());
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('logs instead of throwing when the write fails', () => {
    const bad = path.join(dir, 'missing-subdir', 'cache.json');
    expect(() => writeJsonAtomic(log, bad, validCache())).not.toThrow();
    expect(log.messages.some((m) => m.includes('Failed to persist'))).toBe(true);
  });

  it('refuses to write through a pre-planted temp path (exclusive create)', () => {
    // A symlink at the temp path would redirect a non-exclusive write to
    // the victim. With `wx` the open fails, the victim is untouched, the
    // planted link is removed, and the next write proceeds normally.
    const victim = path.join(dir, 'victim.txt');
    fs.writeFileSync(victim, 'original');
    const tmp = `${file}.${process.pid}.tmp`;
    fs.symlinkSync(victim, tmp);

    writeJsonAtomic(log, file, validCache());

    expect(fs.readFileSync(victim, 'utf8')).toBe('original');
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.lstatSync(tmp, { throwIfNoEntry: false })).toBeUndefined();
    expect(log.messages.some((m) => m.includes('Failed to persist'))).toBe(true);

    writeJsonAtomic(log, file, validCache());
    expect(readStationCache(log, file, LAT, LON).stationId).toBe('KSEA');
  });

  it('treats an oversized cache file as corrupt without parsing it', () => {
    const padded = { ...validCache(), pad: 'x'.repeat(CACHE_MAX_BYTES + 1) };
    fs.writeFileSync(file, JSON.stringify(padded));
    const result = readStationCache(log, file, LAT, LON);
    expect(result).toEqual({ stationId: null, wasCorrupted: true });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('refuses to read through a symlinked cache file and removes the link', () => {
    const elsewhere = path.join(dir, 'elsewhere.json');
    fs.writeFileSync(elsewhere, JSON.stringify(validCache()));
    fs.symlinkSync(elsewhere, file);

    const result = readStationCache(log, file, LAT, LON);
    expect(result).toEqual({ stationId: null, wasCorrupted: true });
    expect(fs.lstatSync(file, { throwIfNoEntry: false })).toBeUndefined(); // link removed
    expect(fs.existsSync(elsewhere)).toBe(true); // target untouched
  });

  it('refuses a cache path that is not a regular file', () => {
    fs.mkdirSync(file);
    const result = readStationCache(log, file, LAT, LON);
    expect(result).toEqual({ stationId: null, wasCorrupted: true });
  });

  it('omits the grid note when the cached gridId fails validation', () => {
    writeJsonAtomic(log, file, validCache({ gridId: 'SEW\nFAKE LOG LINE' }));
    expect(readStationCache(log, file, LAT, LON).stationId).toBe('KSEA');
    // The fake log is shared across this describe; inspect the newest line.
    const line = log.messages.filter((m) => m.includes('Using cached NOAA station')).at(-1);
    expect(line).toBe('[info] Using cached NOAA station: KSEA');
  });

  it('returns null when no cache file exists', () => {
    expect(readStationCache(log, file, LAT, LON))
      .toEqual({ stationId: null, wasCorrupted: false });
  });

  it('ignores a cache for different coordinates', () => {
    writeJsonAtomic(log, file, validCache({ latitude: 40.0 }));
    expect(readStationCache(log, file, LAT, LON).stationId).toBeNull();
  });

  it('ignores an expired cache', () => {
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    writeJsonAtomic(log, file, validCache({ timestamp: old }));
    expect(readStationCache(log, file, LAT, LON).stationId).toBeNull();
  });

  it('ignores a cache timestamped in the future', () => {
    writeJsonAtomic(log, file, validCache({ timestamp: Date.now() + 60_000 }));
    expect(readStationCache(log, file, LAT, LON).stationId).toBeNull();
  });

  it('rejects a tampered station ID that could reach a request URL', () => {
    writeJsonAtomic(log, file, validCache({ stationId: '../../../etc' }));
    expect(readStationCache(log, file, LAT, LON).stationId).toBeNull();
  });

  it('deletes a corrupted cache file and reports it', () => {
    fs.writeFileSync(file, 'not json{{{');
    const result = readStationCache(log, file, LAT, LON);
    expect(result).toEqual({ stationId: null, wasCorrupted: true });
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('STATION_ID_RE', () => {
  it('accepts typical NWS station identifiers', () => {
    for (const id of ['KSEA', 'KPAE', 'D2629', 'CO100']) {
      expect(STATION_ID_RE.test(id)).toBe(true);
    }
  });

  it('rejects path or URL metacharacters', () => {
    for (const id of ['../etc', 'KSEA/obs', 'ksea', 'K SEA', '', 'A'.repeat(9)]) {
      expect(STATION_ID_RE.test(id)).toBe(false);
    }
  });
});

describe('GRID_ID_RE', () => {
  it('accepts NWS office identifiers and rejects everything else', () => {
    for (const id of ['SEW', 'OKX', 'LWX', 'AFG']) {
      expect(GRID_ID_RE.test(id)).toBe(true);
    }
    for (const id of ['sew', 'S', 'SEWXX', 'SE W', 'SEW\n', '../x', '']) {
      expect(GRID_ID_RE.test(id)).toBe(false);
    }
  });
});
