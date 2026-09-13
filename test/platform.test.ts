import type { API, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NOAAWeatherPlatform } from '../src/platform.js';
import { NOAAWeatherAccessory } from '../src/platformAccessory.js';
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
  const fn = (platform as unknown as Record<string, ((...a: unknown[]) => T) | undefined>)[method];
  if (!fn) {
    throw new Error(`Missing method ${method}`);
  }
  return fn.apply(platform, args);
}

const VALID = { latitude: 47.6204, longitude: -122.3494 };

describe('parseConfig', () => {
  it('accepts a minimal valid config with defaults', () => {
    const { platform } = makePlatform(VALID);
    const cfg = invoke<Record<string, unknown>>(platform, 'parseConfig');
    expect(cfg).toEqual({
      latitude: 47.62,
      longitude: -122.35,
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

  it('coarsens coordinates to 2 decimals (~1 km) before they leave the process', () => {
    const { platform } = makePlatform({ latitude: 47.620422, longitude: -122.349358 });
    const cfg = invoke<{ latitude: number; longitude: number }>(platform, 'parseConfig');
    expect(cfg.latitude).toBe(47.62);
    expect(cfg.longitude).toBe(-122.35);
  });

  it('enforces the 5 minute refresh floor', () => {
    const { platform } = makePlatform({ ...VALID, refreshInterval: 1 });
    const cfg = invoke<{ baseRefreshMs: number }>(platform, 'parseConfig');
    expect(cfg.baseRefreshMs).toBe(5 * 60 * 1000);
  });

  it('clamps refreshInterval to the 1440 minute ceiling and warns', () => {
    // Values above ~8948 minutes would overflow Node's 32-bit setTimeout
    // limit under the 4x adaptive multiplier and poll continuously.
    const { platform, log } = makePlatform({ ...VALID, refreshInterval: 100_000 });
    const cfg = invoke<{ baseRefreshMs: number }>(platform, 'parseConfig');
    expect(cfg.baseRefreshMs).toBe(1440 * 60 * 1000);
    expect(log.messages.some((m) => m.includes('outside 5-1440'))).toBe(true);
  });

  it('strips CR/LF from a rejected stationId before echoing it to the log', () => {
    const { platform, log } = makePlatform({ ...VALID, stationId: 'AB\nFAKE-LOG-LINE' });
    expect(invoke<{ stationId: string | null }>(platform, 'parseConfig').stationId)
      .toBeNull();
    const warned = log.messages.find((m) => m.includes('is invalid'));
    expect(warned).toBeDefined();
    expect(warned).not.toMatch(/[\r\n]/);
    expect(log.messages.some((m) => m.includes('Falling back to auto-discovery'))).toBe(true);
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

  it('strips C0, DEL, and C1 controls that would make undici reject the header', () => {
    const { platform } = makePlatform({
      ...VALID,
      userAgentContact: 'me@\u0000example\u007f.com\u0085\tx',
    });
    const ua = invoke<string>(platform, 'buildUserAgent');
    expect(ua).toContain('me@example.comx');
    // The result must be a valid header value end to end.
    expect(() => new Headers({ 'User-Agent': ua })).not.toThrow();
  });

  it('strips non-ByteString Unicode so the User-Agent remains constructible', () => {
    const { platform } = makePlatform({
      ...VALID,
      userAgentContact: 'Kevin 🌧️ <kevin@example.com>',
    });
    const ua = invoke<string>(platform, 'buildUserAgent');
    expect(ua).toContain('Kevin  <kevin@example.com>');
    expect(ua).not.toContain('🌧️');
    expect(() => new Headers({ 'User-Agent': ua })).not.toThrow();
  });
});

describe('coordinate privacy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('never writes the coordinates to the log, even on request failure', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noaa-platform-test-'));
    try {
      // 404 is non-retryable: fetchJson fails fast and its error message
      // (which names the URL) is logged by discoverStation.
      vi.stubGlobal('fetch', vi.fn(async () =>
        new Response('', { status: 404, statusText: 'Not Found' }),
      ));
      const { platform, log } = makePlatform({ latitude: 47.620422, longitude: -122.349358 });
      const result = await invoke<Promise<string | null>>(
        platform, 'discoverStation', 47.62, -122.35, path.join(dir, 'cache.json'),
      );
      expect(result).toBeNull();
      expect(log.messages.length).toBeGreaterThan(0);
      for (const m of log.messages) {
        expect(m).not.toMatch(/47\.62|122\.35/);
      }
      expect(log.messages.some((m) => m.includes('/points/<coordinates>'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps coordinates out of the invalid-response error line', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ properties: { gridId: 'bad id' } }), { status: 200 }),
    ));
    const { platform, log } = makePlatform(VALID);
    const result = await invoke<Promise<string | null>>(
      platform, 'discoverStation', 47.62, -122.35, '/nonexistent/cache.json',
    );
    expect(result).toBeNull();
    for (const m of log.messages) {
      expect(m).not.toMatch(/47\.62|122\.35/);
    }
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

  it('sanitizes an unknown unitCode before echoing it to the log', () => {
    expect(extract({ value: 1, unitCode: 'wmoUnit:x\r\n[error] forged', qualityControl: 'V' }))
      .toBeNull();
    const line = log.messages.find((m) => m.includes('Unknown temperature unit'));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/[\r\n]/);
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

  it('rejects absent, non-number, and non-finite values from JSON', () => {
    expect(extract(undefined)).toBeNull();
    expect(extract({ value: null })).toBeNull();
    expect(extract({ value: '21.5', unitCode: 'wmoUnit:degC' })).toBeNull();
    expect(extract({ value: true, unitCode: 'wmoUnit:degC' })).toBeNull();
    expect(extract({ value: Number.NaN, unitCode: 'wmoUnit:degC' })).toBeNull();
    expect(extract({
      value: JSON.parse('{"value":1e400}').value,
      unitCode: 'wmoUnit:degC',
    })).toBeNull();
  });

  it('rejects malformed unit and quality-control fields', () => {
    expect(extract({ value: 21.5, unitCode: 42, qualityControl: 'V' })).toBeNull();
    expect(extract({ value: 21.5, unitCode: 'wmoUnit:degC', qualityControl: 42 })).toBeNull();
    expect(extract({ value: 21.5, unitCode: null, qualityControl: null })).toBe(21.5);
  });
});

describe('discovery-blocked boot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('tracks staleness for a restored accessory while discovery keeps failing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noaa-platform-test-'));
    try {
      const chainableService = () => {
        const svc: Record<string, unknown> = {
          updateCharacteristic: vi.fn(),
        };
        svc.setCharacteristic = vi.fn(() => svc);
        return svc;
      };
      const restoredAccessory = {
        UUID: 'uuid-noaa-weather-unique',
        displayName: 'NOAA Weather',
        getService: vi.fn(() => chainableService()),
        getServiceById: vi.fn(() => chainableService()),
        addService: vi.fn(() => chainableService()),
      } as unknown as PlatformAccessory;

      const api = {
        hap: {
          Service: {},
          Characteristic: {},
          uuid: { generate: (s: string) => `uuid-${s}` },
        },
        on: () => undefined,
        user: { persistPath: () => dir },
      } as unknown as API;

      // Non-network error: the client fails fast without backoff sleeps.
      vi.stubGlobal('fetch', vi.fn(async () => {
        throw new Error('discovery unavailable');
      }));
      const noteFailure = vi.spyOn(NOAAWeatherAccessory.prototype, 'noteObservationFailure');

      const log = makeFakeLog();
      const platform = new NOAAWeatherPlatform(
        log as Logging,
        { platform: 'NOAAWeather', ...VALID } as PlatformConfig,
        api,
      );
      platform.configureAccessory(restoredAccessory);

      await (platform as unknown as { discoverDevices(): Promise<void> }).discoverDevices();

      // The handler exists before discovery ever succeeds, and the failure
      // path evaluates staleness on it instead of leaving it untracked.
      expect(noteFailure).toHaveBeenCalledTimes(1);
      expect(log.messages.some((m) => m.includes('Restoring NOAA Weather accessory'))).toBe(true);
      expect(log.messages.some((m) => m.includes('Station discovery failed; retrying'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('healthy station selection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const pointBody = JSON.stringify({
    properties: { gridId: 'SEW', gridX: 138, gridY: 80 },
  });
  const stationsBody = (...stationIds: string[]) => JSON.stringify({
    features: stationIds.map((stationIdentifier) => ({ properties: { stationIdentifier } })),
  });
  const observationBody = (timestamp: string, temperature = 14) => JSON.stringify({
    properties: {
      timestamp,
      temperature: { value: temperature, unitCode: 'wmoUnit:degC', qualityControl: 'V' },
      relativeHumidity: { value: 82, unitCode: 'wmoUnit:percent', qualityControl: 'V' },
    },
  });

  it('skips a stale nearest station and caches the next fresh candidate', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T15:30:00Z'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noaa-selection-test-'));
    const cacheFile = path.join(dir, 'points.json');
    try {
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/points/')) {
          return new Response(pointBody, { status: 200 });
        }
        if (url.includes('/gridpoints/')) {
          return new Response(stationsBody('D2629', 'KPAE'), { status: 200 });
        }
        if (url.includes('/stations/D2629/')) {
          return new Response(observationBody('2026-09-01T18:00:00Z', 18.89), { status: 200 });
        }
        return new Response(observationBody('2026-09-07T15:20:00Z'), { status: 200 });
      });
      vi.stubGlobal('fetch', fetchMock);
      const { platform, log } = makePlatform(VALID);

      const selection = await invoke<Promise<{ stationId: string } | null>>(
        platform, 'discoverStation', 47.62, -122.35, cacheFile,
      );

      expect(selection?.stationId).toBe('KPAE');
      expect(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).stationId).toBe('KPAE');
      expect(log.messages.some((m) => m.includes('D2629') && m.includes('stale'))).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bounds station probes to the nearest ten candidates', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T15:30:00Z'));
    const candidates = Array.from({ length: 11 }, (_, i) => `D${String(i).padStart(4, '0')}`);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/points/')) {
        return new Response(pointBody, { status: 200 });
      }
      if (url.includes('/gridpoints/')) {
        return new Response(stationsBody(...candidates), { status: 200 });
      }
      return new Response(observationBody('2026-09-01T18:00:00Z'), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { platform } = makePlatform(VALID);

    const selection = await invoke<Promise<unknown>>(
      platform, 'discoverStation', 47.62, -122.35, '/nonexistent/points.json',
    );

    expect(selection).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(12); // points + station list + 10 probes
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes(candidates[10]!))).toBe(false);
  });

  it('skips a missing station without retrying it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T15:30:00Z'));
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/points/')) {
        return new Response(pointBody, { status: 200 });
      }
      if (url.includes('/gridpoints/')) {
        return new Response(stationsBody('D2629', 'KPAE'), { status: 200 });
      }
      if (url.includes('/stations/D2629/')) {
        return new Response('', { status: 404 });
      }
      return new Response(observationBody('2026-09-07T15:20:00Z'), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { platform } = makePlatform(VALID);

    const selection = await invoke<Promise<{ stationId: string } | null>>(
      platform, 'discoverStation', 47.62, -122.35, '/nonexistent/points.json',
    );

    expect(selection?.stationId).toBe('KPAE');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not select a station whose observation has no valid timestamp', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T15:30:00Z'));
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/points/')) {
        return new Response(pointBody, { status: 200 });
      }
      if (url.includes('/gridpoints/')) {
        return new Response(stationsBody('D2629', 'KPAE'), { status: 200 });
      }
      if (url.includes('/stations/D2629/')) {
        return new Response(JSON.stringify({
          properties: {
            temperature: { value: 18.89, unitCode: 'wmoUnit:degC' },
          },
        }), { status: 200 });
      }
      return new Response(observationBody('2026-09-07T15:20:00Z'), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { platform } = makePlatform(VALID);

    const selection = await invoke<Promise<{ stationId: string } | null>>(
      platform, 'discoverStation', 47.62, -122.35, '/nonexistent/points.json',
    );

    expect(selection?.stationId).toBe('KPAE');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not fan out probes during a general network failure', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/points/')) {
        return new Response(pointBody, { status: 200 });
      }
      if (url.includes('/gridpoints/')) {
        return new Response(stationsBody('D2629', 'KPAE'), { status: 200 });
      }
      throw new Error('network unavailable');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { platform } = makePlatform(VALID);

    const selection = await invoke<Promise<unknown>>(
      platform, 'discoverStation', 47.62, -122.35, '/nonexistent/points.json',
    );

    expect(selection).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/stations/KPAE/')))
      .toBe(false);
  });
});

describe('startPolling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // Minimal handler stand-in: startPolling only calls these two methods.
  const makeHandler = (applyResult = false) => ({
    applyReading: vi.fn(() => applyResult),
    noteObservationFailure: vi.fn(),
    shutdown: vi.fn(),
  }) as unknown as NOAAWeatherAccessory;

  const OBSERVATION_URL_BODY = JSON.stringify({
    properties: { temperature: { value: 20, unitCode: 'wmoUnit:degC' } },
  });
  const BASE_MS = 5 * 60 * 1000;

  it('ignores a second invocation so only one timer chain can exist', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () =>
      new Response(OBSERVATION_URL_BODY, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { platform, log } = makePlatform(VALID);
    const handler = makeHandler();

    invoke(platform, 'startPolling', 'KSEA', handler, BASE_MS, false);
    invoke(platform, 'startPolling', 'KSEA', handler, BASE_MS, false);
    await vi.advanceTimersByTimeAsync(0);

    expect(log.messages.some((m) => m.includes('already polling'))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // one initial tick, not two

    // One base interval (+10% jitter margin) later: exactly one more poll.
    await vi.advanceTimersByTimeAsync(BASE_MS * 1.1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the relaxed adaptive schedule when a poll fails', async () => {
    vi.useFakeTimers();
    let fail = false;
    const fetchMock = vi.fn(async () => {
      if (fail) {
        // Non-network error: fetchJson fails fast without backoff sleeps.
        throw new Error('outage');
      }
      return new Response(OBSERVATION_URL_BODY, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { platform } = makePlatform(VALID);
    const handler = makeHandler(false); // every reading "unchanged"

    invoke(platform, 'startPolling', 'KSEA', handler, BASE_MS, true);
    await vi.advanceTimersByTimeAsync(0); // tick 1: streak 1
    await vi.advanceTimersByTimeAsync(BASE_MS * 1.1); // tick 2: streak 2
    await vi.advanceTimersByTimeAsync(BASE_MS * 1.1); // tick 3: streak 3 -> mult 2
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fail = true;
    await vi.advanceTimersByTimeAsync(2 * BASE_MS * 1.1); // tick 4 fails
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect((handler as unknown as { noteObservationFailure: ReturnType<typeof vi.fn> })
      .noteObservationFailure).toHaveBeenCalledTimes(1);

    // The failure must NOT reset the streak: the next poll still runs on
    // the doubled interval (>= 2 * BASE * 0.9), not the base one.
    await vi.advanceTimersByTimeAsync(BASE_MS * 1.1);
    expect(fetchMock).toHaveBeenCalledTimes(4); // too early for mult=2
    await vi.advanceTimersByTimeAsync(BASE_MS * 1.1);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('treats an empty 200 response as a failed observation', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ properties: {} }), { status: 200 }),
    ));
    const { platform } = makePlatform(VALID);
    const handler = makeHandler();

    invoke(platform, 'startPolling', 'KSEA', handler, BASE_MS, false);
    await vi.advanceTimersByTimeAsync(0);

    const mock = handler as unknown as {
      applyReading: ReturnType<typeof vi.fn>;
      noteObservationFailure: ReturnType<typeof vi.fn>;
    };
    expect(mock.applyReading).not.toHaveBeenCalled();
    expect(mock.noteObservationFailure).toHaveBeenCalledTimes(1);
  });

  it('does not accept a timestamp without any usable measurement', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        properties: { timestamp: new Date().toISOString() },
      }), { status: 200 }),
    ));
    const { platform } = makePlatform(VALID);
    const handler = makeHandler();

    invoke(platform, 'startPolling', 'KSEA', handler, BASE_MS, false);
    await vi.advanceTimersByTimeAsync(0);

    const mock = handler as unknown as {
      applyReading: ReturnType<typeof vi.fn>;
      noteObservationFailure: ReturnType<typeof vi.fn>;
    };
    expect(mock.applyReading).not.toHaveBeenCalled();
    expect(mock.noteObservationFailure).toHaveBeenCalledTimes(1);
  });

  it('ignores malformed presentWeather when measurements remain usable', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        properties: {
          temperature: { value: 20, unitCode: 'wmoUnit:degC' },
          presentWeather: 'not-an-array',
        },
      }), { status: 200 }),
    ));
    const { platform } = makePlatform(VALID);
    const handler = makeHandler();

    invoke(platform, 'startPolling', 'KSEA', handler, BASE_MS, false);
    await vi.advanceTimersByTimeAsync(0);

    expect((handler as unknown as { applyReading: ReturnType<typeof vi.fn> }).applyReading)
      .toHaveBeenCalledTimes(1);
  });

  it('does not retry or reschedule an in-flight poll after shutdown', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () =>
      new Response('', { status: 429, headers: { 'retry-after': '300' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { platform } = makePlatform(VALID);
    const handler = makeHandler();

    invoke(platform, 'startPolling', 'KSEA', handler, BASE_MS, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    invoke(platform, 'shutdown');
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((handler as unknown as { noteObservationFailure: ReturnType<typeof vi.fn> })
      .noteObservationFailure).not.toHaveBeenCalled();
  });

  it('does not mutate accessory state when shutdown interrupts replacement discovery', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T15:30:00Z'));
    let resolvePoint: ((response: Response) => void) | undefined;
    const pendingPoint = new Promise<Response>((resolve) => {
      resolvePoint = resolve;
    });
    const stale = JSON.stringify({
      properties: {
        timestamp: '2026-09-01T18:00:00Z',
        temperature: { value: 18.89, unitCode: 'wmoUnit:degC' },
      },
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/stations/D2629/')) {
        return new Response(stale, { status: 200 });
      }
      if (url.includes('/points/')) {
        return pendingPoint;
      }
      throw new Error('unexpected request');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { platform } = makePlatform(VALID);
    const handler = makeHandler();

    invoke(
      platform,
      'startPolling',
      'D2629',
      handler,
      BASE_MS,
      false,
      { latitude: 47.62, longitude: -122.35, cacheFile: '/unused' },
    );
    for (let i = 0; i < 10 && fetchMock.mock.calls.length < 2; i++) {
      await Promise.resolve();
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);

    invoke(platform, 'shutdown');
    resolvePoint?.(new Response(JSON.stringify({
      properties: { gridId: 'SEW', gridX: 138, gridY: 80 },
    }), { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);

    const mock = handler as unknown as {
      applyReading: ReturnType<typeof vi.fn>;
      noteObservationFailure: ReturnType<typeof vi.fn>;
    };
    expect(mock.applyReading).not.toHaveBeenCalled();
    expect(mock.noteObservationFailure).not.toHaveBeenCalled();
  });

  it('replaces a stale auto-selected station with a fresh candidate', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T15:30:00Z'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noaa-failover-test-'));
    const cacheFile = path.join(dir, 'points.json');
    try {
      const pointBody = JSON.stringify({
        properties: { gridId: 'SEW', gridX: 138, gridY: 80 },
      });
      const stationsBody = JSON.stringify({
        features: [
          { properties: { stationIdentifier: 'D2629' } },
          { properties: { stationIdentifier: 'KPAE' } },
        ],
      });
      const stale = JSON.stringify({
        properties: {
          timestamp: '2026-09-01T18:00:00Z',
          temperature: { value: 18.89, unitCode: 'wmoUnit:degC' },
        },
      });
      const fresh = JSON.stringify({
        properties: {
          timestamp: '2026-09-07T15:20:00Z',
          temperature: { value: 14, unitCode: 'wmoUnit:degC' },
        },
      });
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/stations/D2629/')) {
          return new Response(stale, { status: 200 });
        }
        if (url.includes('/points/')) {
          return new Response(pointBody, { status: 200 });
        }
        if (url.includes('/gridpoints/')) {
          return new Response(stationsBody, { status: 200 });
        }
        return new Response(fresh, { status: 200 });
      });
      vi.stubGlobal('fetch', fetchMock);
      const { platform, log } = makePlatform(VALID);
      const handler = makeHandler();

      invoke(
        platform,
        'startPolling',
        'D2629',
        handler,
        BASE_MS,
        false,
        { latitude: 47.62, longitude: -122.35, cacheFile },
      );
      await vi.advanceTimersByTimeAsync(0);

      const apply = (handler as unknown as {
        applyReading: ReturnType<typeof vi.fn>;
      }).applyReading;
      expect(apply).toHaveBeenCalledTimes(1);
      expect(apply.mock.calls[0]?.[0].temperature).toBe(14);
      expect(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).stationId).toBe('KPAE');
      expect(log.messages.some((m) => m.includes('Switched NOAA station from D2629 to KPAE')))
        .toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never auto-switches an explicitly configured station', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T15:30:00Z'));
    const stale = JSON.stringify({
      properties: {
        timestamp: '2026-09-01T18:00:00Z',
        temperature: { value: 18.89, unitCode: 'wmoUnit:degC' },
      },
    });
    const fetchMock = vi.fn(async () => new Response(stale, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { platform, log } = makePlatform({ ...VALID, stationId: 'D2629' });
    const handler = makeHandler();

    invoke(platform, 'startPolling', 'D2629', handler, BASE_MS, false);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(log.messages.some((m) => m.includes('looking for a replacement'))).toBe(false);
  });

  it('fails over when an auto-selected station disappears', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T15:30:00Z'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noaa-missing-station-test-'));
    try {
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/stations/D2629/')) {
          return new Response('', { status: 404 });
        }
        if (url.includes('/points/')) {
          return new Response(JSON.stringify({
            properties: { gridId: 'SEW', gridX: 138, gridY: 80 },
          }), { status: 200 });
        }
        if (url.includes('/gridpoints/')) {
          return new Response(JSON.stringify({
            features: [
              { properties: { stationIdentifier: 'D2629' } },
              { properties: { stationIdentifier: 'KPAE' } },
            ],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          properties: {
            timestamp: '2026-09-07T15:20:00Z',
            temperature: { value: 14, unitCode: 'wmoUnit:degC' },
          },
        }), { status: 200 });
      });
      vi.stubGlobal('fetch', fetchMock);
      const { platform } = makePlatform(VALID);
      const handler = makeHandler();

      invoke(
        platform,
        'startPolling',
        'D2629',
        handler,
        BASE_MS,
        false,
        {
          latitude: 47.62,
          longitude: -122.35,
          cacheFile: path.join(dir, 'points.json'),
        },
      );
      await vi.advanceTimersByTimeAsync(0);

      expect((handler as unknown as { applyReading: ReturnType<typeof vi.fn> }).applyReading)
        .toHaveBeenCalledWith(expect.objectContaining({ temperature: 14 }));
      expect((handler as unknown as {
        noteObservationFailure: ReturnType<typeof vi.fn>;
      }).noteObservationFailure).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('limits unsuccessful replacement searches to once per hour', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T15:30:00Z'));
    const stale = JSON.stringify({
      properties: {
        timestamp: '2026-09-01T18:00:00Z',
        temperature: { value: 18.89, unitCode: 'wmoUnit:degC' },
      },
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/points/')) {
        return new Response(JSON.stringify({
          properties: { gridId: 'SEW', gridX: 138, gridY: 80 },
        }), { status: 200 });
      }
      if (url.includes('/gridpoints/')) {
        return new Response(JSON.stringify({
          features: [{ properties: { stationIdentifier: 'D2629' } }],
        }), { status: 200 });
      }
      return new Response(stale, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { platform, log } = makePlatform(VALID);
    const handler = makeHandler();

    invoke(
      platform,
      'startPolling',
      'D2629',
      handler,
      24 * 60 * 60 * 1000,
      true,
      { latitude: 47.62, longitude: -122.35, cacheFile: '/unused' },
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(59 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60 * 1000 + 1);

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(log.messages.filter((m) => m.includes('looking for a replacement'))).toHaveLength(2);
    const mock = handler as unknown as {
      applyReading: ReturnType<typeof vi.fn>;
      noteObservationFailure: ReturnType<typeof vi.fn>;
    };
    expect(mock.applyReading).not.toHaveBeenCalled();
    expect(mock.noteObservationFailure).toHaveBeenCalledTimes(2);
  });

  it('returns to the normal cadence when the station recovers after a failed search', async () => {
    // Regression for v1.10.4: a failover cooldown deadline that had already
    // passed collapsed the poll delay to 1 ms, producing ~1000 requests per
    // second against NWS once a stale station came back on its own.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T15:30:00Z'));
    let stationFresh = false;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/points/')) {
        return new Response(JSON.stringify({
          properties: { gridId: 'SEW', gridX: 138, gridY: 80 },
        }), { status: 200 });
      }
      if (url.includes('/gridpoints/')) {
        return new Response(JSON.stringify({
          features: [{ properties: { stationIdentifier: 'D2629' } }],
        }), { status: 200 });
      }
      const timestamp = stationFresh
        ? new Date(Date.now() - 10 * 60_000).toISOString()
        : '2026-09-01T18:00:00Z';
      return new Response(JSON.stringify({
        properties: { timestamp, temperature: { value: 14, unitCode: 'wmoUnit:degC' } },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { platform } = makePlatform(VALID);
    const handler = makeHandler(true);

    invoke(
      platform,
      'startPolling',
      'D2629',
      handler,
      BASE_MS,
      false,
      { latitude: 47.62, longitude: -122.35, cacheFile: '/unused' },
    );
    await vi.advanceTimersByTimeAsync(0); // stale -> replacement search fails
    expect(fetchMock).toHaveBeenCalledTimes(3);

    stationFresh = true;
    for (let i = 0; i < 61; i++) {
      await vi.advanceTimersByTimeAsync(60_000); // cross the one-hour cooldown
    }
    const afterCooldown = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    // At most one poll per minute is ever possible; at BASE_MS cadence, none.
    expect(fetchMock.mock.calls.length - afterCooldown).toBeLessThanOrEqual(1);

    // Cadence is back to the base interval: exactly one poll per period.
    const before = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(BASE_MS * 1.1);
    expect(fetchMock.mock.calls.length - before).toBe(1);
  });

  it('never schedules a poll sooner than the one-minute floor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T15:30:00Z'));
    const fetchMock = vi.fn(async () => new Response(OBSERVATION_URL_BODY, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { platform } = makePlatform(VALID);

    // The constructor already validated refresh bounds; feed the poller an
    // out-of-contract tiny interval directly to prove the floor holds.
    invoke(platform, 'startPolling', 'KSEA', makeHandler(), 1, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reuses a probed initial observation without another request', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { platform } = makePlatform(VALID);
    const handler = makeHandler();
    const initial = { temperature: 14, humidity: 82, observedAt: Date.now() };

    invoke(
      platform,
      'startPolling',
      'KPAE',
      handler,
      BASE_MS,
      false,
      { latitude: 47.62, longitude: -122.35, cacheFile: '/unused' },
      initial,
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).not.toHaveBeenCalled();
    expect((handler as unknown as { applyReading: ReturnType<typeof vi.fn> }).applyReading)
      .toHaveBeenCalledWith(initial);
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

  it('rejects failed QC, absent, non-number, and non-finite values', () => {
    expect(extract({ value: 50, qualityControl: 'X' })).toBeNull();
    expect(extract(undefined)).toBeNull();
    expect(extract({ value: '50', qualityControl: 'V' })).toBeNull();
    expect(extract({ value: Number.POSITIVE_INFINITY, qualityControl: 'V' })).toBeNull();
  });
});
