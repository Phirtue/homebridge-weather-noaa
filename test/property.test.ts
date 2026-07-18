/**
 * Property-based tests (fast-check). Where the example-based suites pin
 * down known cases, these throw randomized input at the parsing and
 * clamping surfaces — the code that faces network-controlled data — and
 * assert invariants that must hold for EVERY input: waits stay bounded,
 * conversions stay finite, nothing unsanitized survives into a URL.
 */
import type { API, Logging, PlatformConfig } from 'homebridge';
import * as os from 'os';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { NwsClient, withJitter } from '../src/nwsClient.js';
import { NOAAWeatherPlatform } from '../src/platform.js';
import { STATION_ID_RE } from '../src/stationCache.js';
import { makeFakeLog } from './helpers.js';

const RETRY_FLOOR_MS = 5_000;
const RETRY_CAP_MS = 300_000;

function makeFakeApi(): API {
  return {
    hap: {
      Service: {},
      Characteristic: {},
      uuid: { generate: (s: string) => `uuid-${s}` },
    },
    on: () => undefined,
    user: { persistPath: () => os.tmpdir() },
  } as unknown as API;
}

function makePlatform(): NOAAWeatherPlatform {
  return new NOAAWeatherPlatform(
    makeFakeLog() as Logging,
    { platform: 'NOAAWeather', latitude: 47.6204, longitude: -122.3494 } as PlatformConfig,
    makeFakeApi(),
  );
}

// Private-method access for focused unit tests.
function invoke<T>(target: object, method: string, ...args: unknown[]): T {
  return (target as Record<string, (...a: unknown[]) => T>)[method](...args);
}

// JSON.parse can never produce NaN or Infinity, so API-sourced numbers are
// always finite; the generators mirror that reachable domain.
const finiteDouble = (min: number, max: number) =>
  fc.double({ min, max, noNaN: true, noDefaultInfinity: true });

describe('withJitter properties', () => {
  it('stays within +/-10% and returns an integer for any delay', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 }), (ms) => {
        const v = withJitter(ms);
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(Math.floor(ms * 0.9));
        expect(v).toBeLessThanOrEqual(Math.ceil(ms * 1.1));
      }),
    );
  });
});

describe('parseRetryAfter properties', () => {
  const client = new NwsClient(makeFakeLog() as Logging, 'test-agent');
  const parse = (header: string | null, fallback: number): number =>
    invoke<number>(client, 'parseRetryAfter', header, fallback);

  it('never yields a wait outside the fallback or the [floor, cap] band', () => {
    // The header is attacker-influencable (it is read before the body is
    // trusted), so this invariant is the whole defense: no header string,
    // however malformed, may produce an unbounded or negative wait.
    fc.assert(
      fc.property(
        fc.string(),
        fc.integer({ min: 0, max: RETRY_CAP_MS }),
        (header, fallback) => {
          const ms = parse(header, fallback);
          expect(Number.isFinite(ms)).toBe(true);
          const inBand = ms >= RETRY_FLOOR_MS && ms <= RETRY_CAP_MS;
          expect(ms === fallback || inBand).toBe(true);
        },
      ),
    );
  });

  it('clamps any numeric seconds value into the [floor, cap] band', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_000 }), (seconds) => {
        const expected = Math.min(Math.max(seconds * 1000, RETRY_FLOOR_MS), RETRY_CAP_MS);
        expect(parse(String(seconds), 1_000)).toBe(expected);
      }),
    );
  });

  it('clamps any future HTTP-date into the [floor, cap] band', () => {
    // Minimum delta of 2s: toUTCString() truncates to whole seconds, so a
    // date under ~1s out can land in the past and (correctly) hit the
    // fallback path instead of the clamp.
    fc.assert(
      fc.property(fc.integer({ min: 2_000, max: 7 * 24 * 60 * 60 * 1000 }), (deltaMs) => {
        const ms = parse(new Date(Date.now() + deltaMs).toUTCString(), 1_000);
        expect(ms).toBeGreaterThanOrEqual(RETRY_FLOOR_MS);
        expect(ms).toBeLessThanOrEqual(RETRY_CAP_MS);
      }),
    );
  });
});

describe('extractTemperatureC properties', () => {
  const platform = makePlatform();
  const extract = (qv: unknown): number | null =>
    invoke<number | null>(platform, 'extractTemperatureC', qv);

  it('round-trips Fahrenheit and Kelvin conversions back to Celsius', () => {
    fc.assert(
      fc.property(finiteDouble(-1_000, 1_000), (celsius) => {
        const viaF = extract({
          value: celsius * (9 / 5) + 32, unitCode: 'wmoUnit:degF', qualityControl: 'V',
        });
        const viaK = extract({
          value: celsius + 273.15, unitCode: 'wmoUnit:K', qualityControl: 'V',
        });
        const tolerance = 1e-9 * Math.max(1, Math.abs(celsius));
        expect(Math.abs((viaF as number) - celsius)).toBeLessThanOrEqual(tolerance);
        expect(Math.abs((viaK as number) - celsius)).toBeLessThanOrEqual(tolerance);
      }),
    );
  });

  it('always yields a finite number or null for known units', () => {
    fc.assert(
      fc.property(
        finiteDouble(-1e9, 1e9),
        fc.constantFrom('wmoUnit:degC', 'wmoUnit:degF', 'wmoUnit:K', ''),
        (value, unitCode) => {
          const result = extract({ value, unitCode, qualityControl: 'V' });
          expect(result === null || Number.isFinite(result)).toBe(true);
        },
      ),
    );
  });

  it('rejects every QC flag outside the accepted MADIS set', () => {
    const accepted = new Set(['V', 'C', 'S', 'G', 'Z']);
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((qc) => !accepted.has(qc)),
        finiteDouble(-100, 100),
        (qc, value) => {
          expect(extract({ value, unitCode: 'wmoUnit:degC', qualityControl: qc })).toBeNull();
        },
      ),
    );
  });

  it('rejects every unit string outside the known set', () => {
    // The parser matches units by suffix (degc/degf/k), so the generator
    // must exclude any random string that happens to end in one of them.
    const knownSuffix = /(degc|degf|k)$/i;
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((u) => !knownSuffix.test(u)),
        finiteDouble(-100, 100),
        (unitCode, value) => {
          expect(extract({ value, unitCode, qualityControl: 'V' })).toBeNull();
        },
      ),
    );
  });
});

describe('extractHumidity properties', () => {
  const platform = makePlatform();
  const extract = (qv: unknown): number | null =>
    invoke<number | null>(platform, 'extractHumidity', qv);

  it('clamps any finite value into 0..100', () => {
    fc.assert(
      fc.property(finiteDouble(-1e12, 1e12), (value) => {
        const result = extract({ value, qualityControl: 'V' });
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(100);
      }),
    );
  });
});

describe('STATION_ID_RE properties', () => {
  it('accepted IDs are URL-inert: uppercase, bounded, no encodable characters', () => {
    // A cached station ID is interpolated into a request path, so anything
    // the regex accepts must pass through encodeURIComponent unchanged.
    fc.assert(
      fc.property(fc.string(), (s) => {
        if (STATION_ID_RE.test(s)) {
          expect(s.length).toBeGreaterThanOrEqual(3);
          expect(s.length).toBeLessThanOrEqual(8);
          expect(s).toBe(s.toUpperCase());
          expect(encodeURIComponent(s)).toBe(s);
        }
      }),
    );
  });

  it('rejects any string containing a character outside A-Z and 0-9', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => /[^A-Z0-9]/.test(s)),
        (s) => {
          expect(STATION_ID_RE.test(s)).toBe(false);
        },
      ),
    );
  });
});
