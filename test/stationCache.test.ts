import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readStationCache, writeJsonAtomic, STATION_ID_RE, PointsCache } from '../src/stationCache.js';
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
