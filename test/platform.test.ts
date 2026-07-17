import type { API, Logging, PlatformConfig } from 'homebridge';
import * as os from 'os';
import { describe, expect, it } from 'vitest';

import { NOAAWeatherPlatform } from '../src/platform.js';
import { makeFakeLog, FakeLog } from './helpers.js';

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

function makePlatform(config: Record<string, unknown>): {
  platform: NOAAWeatherPlatform;
  log: FakeLog;
} {
  const log = makeFakeLog();
  const platform = new NOAAWeatherPlatform(
    log as Logging,
    { platform: 'NOAAWeather', ...config } as PlatformConfig,
    makeFakeApi(),
  );
  return { platform, log };
}

// Private-method access for focused unit tests.
function invoke<T>(platform: NOAAWeatherPlatform, method: string, ...args: unknown[]): T {
  return (platform as unknown as Record<string, (...a: unknown[]) => T>)[method](...args);
}

const VALID = { latitude: 47.6204, longitude: -122.3494 };

describe('parseConfig', () => {
  it('accepts a minimal valid config with defaults', () => {
    const { platform } = makePlatform(VALID);
    const cfg = invoke<Record<string, unknown>>(platform, 'parseConfig');
    expect(cfg).toMatchObject({
      latitude: 47.6204,
      longitude: -122.3494,
      baseRefreshMs: 15 * 60 * 1000,
      adaptivePolling: true,
      stationId: null,
    });
  });

  it('rejects missing or out-of-range coordinates', () => {
    for (const bad of [
      {},
      { latitude: 91, longitude: 0 },
      { latitude: 0, longitude: -181 },
      { latitude: 'abc', longitude: 0 },
    ]) {
      const { platform, log } = makePlatform(bad);
      expect(invoke(platform, 'parseConfig')).toBeNull();
      expect(log.messages.some((m) => m.includes('Plugin will not start'))).toBe(true);
    }
  });

  it('rounds coordinates to the 4 decimals the NWS API accepts', () => {
    const { platform } = makePlatform({ latitude: 47.620422, longitude: -122.349358 });
    const cfg = invoke<{ latitude: number; longitude: number }>(platform, 'parseConfig');
    expect(cfg.latitude).toBe(47.6204);
    expect(cfg.longitude).toBe(-122.3494);
  });

  it('enforces the 5 minute refresh floor', () => {
    const { platform } = makePlatform({ ...VALID, refreshInterval: 1 });
    const cfg = invoke<{ baseRefreshMs: number }>(platform, 'parseConfig');
    expect(cfg.baseRefreshMs).toBe(5 * 60 * 1000);
  });

  it('normalizes a valid stationId and rejects an invalid one', () => {
    const ok = makePlatform({ ...VALID, stationId: ' ksea ' });
    expect(invoke<{ stationId: string }>(ok.platform, 'parseConfig').stationId).toBe('KSEA');

    const bad = makePlatform({ ...VALID, stationId: '../etc' });
    expect(invoke<{ stationId: string | null }>(bad.platform, 'parseConfig').stationId)
      .toBeNull();
    expect(bad.log.messages.some((m) => m.includes('Falling back to auto-discovery'))).toBe(true);
  });
});

describe('buildUserAgent', () => {
  it('strips CR/LF from the contact to prevent header injection', () => {
    const { platform } = makePlatform({
      ...VALID,
      userAgentContact: 'me@example.com\r\nX-Injected: 1',
    });
    const ua = invoke<string>(platform, 'buildUserAgent');
    expect(ua).not.toMatch(/[\r\n]/);
    expect(ua).toContain('me@example.comX-Injected: 1');
  });
});

describe('extractTemperatureC', () => {
  const { platform, log } = makePlatform(VALID);
  const extract = (qv: unknown): number | null =>
    invoke<number | null>(platform, 'extractTemperatureC', qv);

  it('passes Celsius through', () => {
    expect(extract({ value: 21.5, unitCode: 'wmoUnit:degC', qualityControl: 'V' })).toBe(21.5);
  });

  it('converts Fahrenheit', () => {
    expect(extract({ value: 70, unitCode: 'wmoUnit:degF', qualityControl: 'V' }))
      .toBeCloseTo(21.111, 3);
  });

  it('converts Kelvin', () => {
    expect(extract({ value: 294.65, unitCode: 'wmoUnit:K', qualityControl: 'V' }))
      .toBeCloseTo(21.5, 3);
  });

  it('assumes Celsius for a missing unitCode and logs it once', () => {
    expect(extract({ value: 10, qualityControl: 'V' })).toBe(10);
    expect(extract({ value: 11, qualityControl: 'V' })).toBe(11);
    const traces = log.messages.filter((m) => m.includes('assuming Celsius'));
    expect(traces).toHaveLength(1);
  });

  it('rejects unknown units', () => {
    expect(extract({ value: 21.5, unitCode: 'wmoUnit:furlongs', qualityControl: 'V' }))
      .toBeNull();
  });

  it('rejects readings that failed MADIS quality control', () => {
    for (const qc of ['X', 'Q', 'B', 'T']) {
      expect(extract({ value: 21.5, unitCode: 'wmoUnit:degC', qualityControl: qc })).toBeNull();
    }
  });

  it('accepts all approved MADIS QC flags', () => {
    for (const qc of ['V', 'C', 'S', 'G', 'Z']) {
      expect(extract({ value: 21.5, unitCode: 'wmoUnit:degC', qualityControl: qc })).toBe(21.5);
    }
  });

  it('returns null for absent values', () => {
    expect(extract(undefined)).toBeNull();
    expect(extract({ value: null })).toBeNull();
  });
});

describe('extractHumidity', () => {
  const { platform } = makePlatform(VALID);
  const extract = (qv: unknown): number | null =>
    invoke<number | null>(platform, 'extractHumidity', qv);

  it('clamps to 0..100', () => {
    expect(extract({ value: 150, qualityControl: 'V' })).toBe(100);
    expect(extract({ value: -5, qualityControl: 'V' })).toBe(0);
    expect(extract({ value: 55.5, qualityControl: 'V' })).toBe(55.5);
  });

  it('rejects failed QC and absent values', () => {
    expect(extract({ value: 50, qualityControl: 'X' })).toBeNull();
    expect(extract(undefined)).toBeNull();
  });
});
