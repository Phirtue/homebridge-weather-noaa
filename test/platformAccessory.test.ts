import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi, Mock } from 'vitest';

import { NOAAWeatherAccessory } from '../src/platformAccessory.js';
import type { NOAAWeatherPlatform } from '../src/platform.js';
import type { PlatformAccessory } from 'homebridge';
import { makeFakeLog } from './helpers.js';

interface FakeService {
  displayName: string;
  updateCharacteristic: Mock;
  setCharacteristic: Mock;
}

function makeService(name: string): FakeService {
  const service: FakeService = {
    displayName: name,
    updateCharacteristic: vi.fn(),
    setCharacteristic: vi.fn(),
  };
  service.setCharacteristic.mockReturnValue(service);
  return service;
}

// Sentinel identifiers standing in for HAP service/characteristic classes.
const Service = {
  AccessoryInformation: 'AccessoryInformation',
  TemperatureSensor: 'TemperatureSensor',
  HumiditySensor: 'HumiditySensor',
};
const Characteristic = {
  Manufacturer: 'Manufacturer',
  Model: 'Model',
  SerialNumber: 'SerialNumber',
  FirmwareRevision: 'FirmwareRevision',
  CurrentTemperature: 'CurrentTemperature',
  CurrentRelativeHumidity: 'CurrentRelativeHumidity',
  StatusActive: 'StatusActive',
};

function makeHarness(persistDir: string) {
  const log = makeFakeLog();
  const info = makeService('Information');
  const temp = makeService('NOAA Temperature');
  const humidity = makeService('NOAA Humidity');

  const accessory = {
    getService: vi.fn((s: unknown) => (s === Service.AccessoryInformation ? info : undefined)),
    getServiceById: vi.fn((s: unknown) =>
      s === Service.TemperatureSensor ? temp
        : s === Service.HumiditySensor ? humidity : undefined,
    ),
    addService: vi.fn(),
  } as unknown as PlatformAccessory;

  const platform = {
    log,
    api: { user: { persistPath: () => persistDir } },
    Service,
    Characteristic,
  } as unknown as NOAAWeatherPlatform;

  return { log, temp, humidity, accessory, platform };
}

describe('NOAAWeatherAccessory', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noaa-acc-test-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const cacheFile = () => path.join(dir, 'noaa-weather-last.json');

  it('shows the active station in the accessory Model field', () => {
    const h = makeHarness(dir);
    const acc = new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');
    const info = (h.accessory.getService as Mock).mock.results[0]?.value as FakeService;
    expect(info.setCharacteristic).toHaveBeenCalledWith(Characteristic.Model, 'Weather Station');

    acc.setStation('KSEA');
    expect(info.updateCharacteristic).toHaveBeenCalledWith(Characteristic.Model, 'NWS Station KSEA');
    acc.setStation('KPAE');
    expect(info.updateCharacteristic).toHaveBeenLastCalledWith(Characteristic.Model, 'NWS Station KPAE');
  });

  it('presents the release core of a prerelease version as FirmwareRevision', () => {
    for (const [version, expected] of [
      ['1.11.1', '1.11.1'],
      ['1.12.0-beta.1', '1.12.0'],
      ['2.0.0-rc.3+build.7', '2.0.0'],
      ['not-a-version', '0.0.0'],
    ]) {
      const h = makeHarness(dir);
      new NOAAWeatherAccessory(h.platform, h.accessory, version as string);
      const info = (h.accessory.getService as Mock).mock.results[0]?.value as FakeService;
      expect(info.setCharacteristic).toHaveBeenCalledWith(Characteristic.FirmwareRevision, expected);
    }
  });

  it('adds the sensor services on a first run when the accessory has none', () => {
    const h = makeHarness(dir);
    (h.accessory.getServiceById as Mock).mockReturnValue(undefined);
    const added: FakeService[] = [];
    (h.accessory.addService as Mock).mockImplementation((_svc: unknown, name: string) => {
      const s = makeService(name);
      added.push(s);
      return s;
    });

    const acc = new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');
    expect(h.accessory.addService).toHaveBeenCalledWith(
      Service.TemperatureSensor, 'NOAA Temperature', 'noaa-temperature',
    );
    expect(h.accessory.addService).toHaveBeenCalledWith(
      Service.HumiditySensor, 'NOAA Humidity', 'noaa-humidity',
    );

    // The freshly added services are the ones that receive readings.
    acc.applyReading({ temperature: 21, humidity: 40 });
    expect(added[0]?.updateCharacteristic)
      .toHaveBeenCalledWith(Characteristic.CurrentTemperature, 21);
    expect(added[1]?.updateCharacteristic)
      .toHaveBeenCalledWith(Characteristic.CurrentRelativeHumidity, 40);
  });

  it('survives a failed Model update', () => {
    const h = makeHarness(dir);
    const acc = new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');
    const info = (h.accessory.getService as Mock).mock.results[0]?.value as FakeService;
    info.updateCharacteristic.mockImplementationOnce(() => {
      throw new Error('HAP rejected value');
    });
    expect(() => acc.setStation('KSEA')).not.toThrow();
    expect(h.log.messages.some((m) => m.includes('Failed to update characteristic'))).toBe(true);
  });

  it('reports change on first reading, no change when within epsilon', () => {
    const h = makeHarness(dir);
    const acc = new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');

    expect(acc.applyReading({ temperature: 20, humidity: 50 })).toBe(true);
    expect(acc.applyReading({ temperature: 20.01, humidity: 50.1 })).toBe(false);
    expect(acc.applyReading({ temperature: 21, humidity: 50 })).toBe(true);
  });

  it('persists the cache only when a reading changed', () => {
    const h = makeHarness(dir);
    const acc = new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');

    acc.applyReading({ temperature: 20, humidity: 50 });
    expect(fs.existsSync(cacheFile())).toBe(true);

    fs.unlinkSync(cacheFile());
    acc.applyReading({ temperature: 20, humidity: 50 });
    expect(fs.existsSync(cacheFile())).toBe(false);

    acc.applyReading({ temperature: 25, humidity: 50 });
    expect(fs.existsSync(cacheFile())).toBe(true);
  });

  it('persists cumulative drift from the disk baseline', () => {
    const h = makeHarness(dir);
    const acc = new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');

    acc.applyReading({ temperature: 20, humidity: 50 });
    acc.applyReading({ temperature: 20.06, humidity: 50 });
    expect(JSON.parse(fs.readFileSync(cacheFile(), 'utf8')).temperature).toBe(20);

    // Each individual step is below epsilon (0.1 °C, the HAP minStep), but
    // total drift from the persisted value now exceeds it and must reach disk.
    acc.applyReading({ temperature: 20.12, humidity: 50 });
    expect(JSON.parse(fs.readFileSync(cacheFile(), 'utf8')).temperature).toBe(20.12);
  });

  it('ignores movement below the HAP minStep, which HomeKit could not display anyway', () => {
    const h = makeHarness(dir);
    const acc = new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');

    expect(acc.applyReading({ temperature: 20, humidity: 50 })).toBe(true);
    // 0.05 °C and 0.9 % both round to the previous HAP step: not a change.
    expect(acc.applyReading({ temperature: 20.05, humidity: 50.9 })).toBe(false);
    // A full step (or more) in either sensor is a real change.
    expect(acc.applyReading({ temperature: 20.5, humidity: 50.9 })).toBe(true);
    expect(acc.applyReading({ temperature: 20.5, humidity: 52 })).toBe(true);
  });

  it('retries persistence after a transient cache write failure', () => {
    const h = makeHarness(dir);
    const acc = new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');
    fs.writeFileSync(`${cacheFile()}.${process.pid}.tmp`, 'block first exclusive create');

    acc.applyReading({ temperature: 20, humidity: 50 });
    expect(fs.existsSync(cacheFile())).toBe(false);

    acc.applyReading({ temperature: 20, humidity: 50 });
    expect(fs.existsSync(cacheFile())).toBe(true);
  });

  it('persists newer freshness hourly even when values do not change', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T12:00:00Z'));
    const h = makeHarness(dir);
    const acc = new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');

    acc.applyReading({ temperature: 20, humidity: 50, observedAt: Date.now() });
    const first = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')).temperatureObservedAt;

    vi.setSystemTime(new Date('2026-07-17T13:00:01Z'));
    acc.applyReading({ temperature: 20, humidity: 50, observedAt: Date.now() });
    const second = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')).temperatureObservedAt;
    expect(second).toBeGreaterThan(first);
  });

  it('clamps out-of-range temperatures to the HomeKit range', () => {
    const h = makeHarness(dir);
    const acc = new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');

    acc.applyReading({ temperature: 150, humidity: null });
    expect(h.temp.updateCharacteristic)
      .toHaveBeenCalledWith(Characteristic.CurrentTemperature, 100);
  });

  it('clamps direct humidity input and rejects non-finite direct values', () => {
    const h = makeHarness(dir);
    const acc = new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');

    acc.applyReading({ temperature: Number.NaN, humidity: 150 });
    // No temperature write at all — not NaN, not a clamped stand-in.
    expect(h.temp.updateCharacteristic)
      .not.toHaveBeenCalledWith(Characteristic.CurrentTemperature, expect.anything());
    expect(h.humidity.updateCharacteristic)
      .toHaveBeenCalledWith(Characteristic.CurrentRelativeHumidity, 100);
  });

  it('retains last values when a reading field is null', () => {
    const h = makeHarness(dir);
    const acc = new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');

    acc.applyReading({ temperature: 20, humidity: 50 });
    h.temp.updateCharacteristic.mockClear();

    acc.applyReading({ temperature: null, humidity: 51 });
    expect(h.temp.updateCharacteristic)
      .not.toHaveBeenCalledWith(Characteristic.CurrentTemperature, expect.anything());
  });

  it('restores clamped cached readings at construction', () => {
    fs.writeFileSync(cacheFile(), JSON.stringify({ temperature: -400, humidity: 150 }));
    const h = makeHarness(dir);
    new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');

    expect(h.temp.updateCharacteristic)
      .toHaveBeenCalledWith(Characteristic.CurrentTemperature, -270);
    expect(h.humidity.updateCharacteristic)
      .toHaveBeenCalledWith(Characteristic.CurrentRelativeHumidity, 100);
  });

  it('discards a corrupted cache file', () => {
    fs.writeFileSync(cacheFile(), '{corrupt');
    const h = makeHarness(dir);
    new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');

    expect(fs.existsSync(cacheFile())).toBe(false);
    expect(h.log.messages.some((m) => m.includes('Corrupted weather cache'))).toBe(true);
  });

  it('discards an oversized cache file without parsing it', () => {
    // Valid JSON, but far past the 64 KB cap: must be treated as corrupt
    // rather than read into memory and honored.
    fs.writeFileSync(
      cacheFile(),
      JSON.stringify({ temperature: 20, humidity: 50, pad: 'x'.repeat(70_000) }),
    );
    const h = makeHarness(dir);
    new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');

    expect(fs.existsSync(cacheFile())).toBe(false);
    expect(h.log.messages.some((m) => m.includes('Corrupted weather cache'))).toBe(true);
    expect(h.temp.updateCharacteristic)
      .not.toHaveBeenCalledWith(Characteristic.CurrentTemperature, 20);
  });

  describe('staleness', () => {
    const HOUR = 60 * 60 * 1000;

    it('clamps a future network timestamp so later failures still become stale', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-17T12:00:00Z'));
      const h = makeHarness(dir);
      const acc = new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');

      acc.applyReading({
        temperature: 20,
        humidity: 50,
        observedAt: new Date('2099-01-01T00:00:00Z').getTime(),
      });
      h.temp.updateCharacteristic.mockClear();

      vi.setSystemTime(new Date('2026-07-17T14:00:01Z'));
      acc.noteObservationFailure();
      expect(h.temp.updateCharacteristic)
        .toHaveBeenCalledWith(Characteristic.StatusActive, false);
      expect(h.humidity.updateCharacteristic)
        .toHaveBeenCalledWith(Characteristic.StatusActive, false);
      vi.useRealTimers();
    });

    it('marks sensors inactive when the observation is older than 2 hours', () => {
      const h = makeHarness(dir);
      const acc = new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');

      acc.applyReading({ temperature: 20, humidity: 50, observedAt: Date.now() });
      h.temp.updateCharacteristic.mockClear();
      h.humidity.updateCharacteristic.mockClear();
      acc.applyReading({ temperature: 20, humidity: 50, observedAt: Date.now() - 3 * HOUR });
      expect(h.temp.updateCharacteristic)
        .toHaveBeenCalledWith(Characteristic.StatusActive, false);
      expect(h.humidity.updateCharacteristic)
        .toHaveBeenCalledWith(Characteristic.StatusActive, false);
      expect(h.log.messages.some((m) => m.includes('stale'))).toBe(true);
    });

    it('expires fresh readings after two hours without waiting for another poll', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-17T12:00:00Z'));
      const h = makeHarness(dir);
      const acc = new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');

      acc.applyReading({ temperature: 20, humidity: 50, observedAt: Date.now() });
      h.temp.updateCharacteristic.mockClear();
      h.humidity.updateCharacteristic.mockClear();

      await vi.advanceTimersByTimeAsync(2 * HOUR + 1);
      expect(h.temp.updateCharacteristic)
        .toHaveBeenCalledWith(Characteristic.StatusActive, false);
      expect(h.humidity.updateCharacteristic)
        .toHaveBeenCalledWith(Characteristic.StatusActive, false);
    });

    it('does not reactivate retained values from a timestamp-only response', () => {
      const h = makeHarness(dir);
      const acc = new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');

      acc.applyReading({ temperature: 20, humidity: 50, observedAt: Date.now() - 3 * HOUR });
      h.temp.updateCharacteristic.mockClear();
      h.humidity.updateCharacteristic.mockClear();
      acc.applyReading({ temperature: null, humidity: null, observedAt: Date.now() });

      expect(h.temp.updateCharacteristic)
        .not.toHaveBeenCalledWith(Characteristic.StatusActive, true);
      expect(h.humidity.updateCharacteristic)
        .not.toHaveBeenCalledWith(Characteristic.StatusActive, true);
    });

    it('tracks freshness independently for partial observations', () => {
      const h = makeHarness(dir);
      const acc = new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');

      acc.applyReading({ temperature: 20, humidity: 50, observedAt: Date.now() - 3 * HOUR });
      h.temp.updateCharacteristic.mockClear();
      h.humidity.updateCharacteristic.mockClear();
      acc.applyReading({ temperature: 21, humidity: null, observedAt: Date.now() });

      expect(h.temp.updateCharacteristic)
        .toHaveBeenCalledWith(Characteristic.StatusActive, true);
      expect(h.humidity.updateCharacteristic)
        .not.toHaveBeenCalledWith(Characteristic.StatusActive, true);
    });

    it('reactivates sensors for valid timestamp-less measurements', () => {
      const h = makeHarness(dir);
      const acc = new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');

      acc.applyReading({ temperature: 20, humidity: 50, observedAt: Date.now() - 3 * HOUR });
      h.temp.updateCharacteristic.mockClear();
      h.humidity.updateCharacteristic.mockClear();
      acc.applyReading({ temperature: 21, humidity: 51, observedAt: null });

      expect(h.temp.updateCharacteristic)
        .toHaveBeenCalledWith(Characteristic.StatusActive, true);
      expect(h.humidity.updateCharacteristic)
        .toHaveBeenCalledWith(Characteristic.StatusActive, true);
    });

    it('recovers to active when a fresh observation arrives', () => {
      const h = makeHarness(dir);
      const acc = new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');

      acc.applyReading({ temperature: 20, humidity: 50, observedAt: Date.now() - 3 * HOUR });
      h.temp.updateCharacteristic.mockClear();

      acc.applyReading({ temperature: 20, humidity: 50, observedAt: Date.now() - 5 * 60_000 });
      expect(h.temp.updateCharacteristic)
        .toHaveBeenCalledWith(Characteristic.StatusActive, true);
    });

    it('does not thrash StatusActive on repeated fresh readings', () => {
      const h = makeHarness(dir);
      const acc = new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');
      h.temp.updateCharacteristic.mockClear();

      acc.applyReading({ temperature: 20, humidity: 50, observedAt: Date.now() });
      acc.applyReading({ temperature: 20, humidity: 50, observedAt: Date.now() });
      const statusCalls = h.temp.updateCharacteristic.mock.calls
        .filter((c) => c[0] === Characteristic.StatusActive);
      expect(statusCalls).toEqual([[Characteristic.StatusActive, true]]);
    });

    it('marks sensors inactive when polls keep failing past the threshold', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-17T12:00:00Z'));
      const h = makeHarness(dir);
      const acc = new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');

      acc.applyReading({ temperature: 20, humidity: 50, observedAt: Date.now() });
      h.temp.updateCharacteristic.mockClear();

      // Failures within the threshold do not flip the state.
      vi.setSystemTime(new Date('2026-07-17T13:00:00Z'));
      acc.noteObservationFailure();
      expect(h.temp.updateCharacteristic)
        .not.toHaveBeenCalledWith(Characteristic.StatusActive, expect.anything());

      // Past the threshold the sensors go inactive.
      vi.setSystemTime(new Date('2026-07-17T15:00:01Z'));
      acc.noteObservationFailure();
      expect(h.temp.updateCharacteristic)
        .toHaveBeenCalledWith(Characteristic.StatusActive, false);
      expect(h.humidity.updateCharacteristic)
        .toHaveBeenCalledWith(Characteristic.StatusActive, false);
      vi.useRealTimers();
    });

    it('does not refresh the staleness clock for an empty reading', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-17T12:00:00Z'));
      const h = makeHarness(dir);
      const acc = new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');

      acc.applyReading({ temperature: 20, humidity: 50, observedAt: Date.now() });
      vi.setSystemTime(new Date('2026-07-17T13:00:00Z'));
      acc.applyReading({ temperature: null, humidity: null, observedAt: null });
      h.temp.updateCharacteristic.mockClear();

      vi.setSystemTime(new Date('2026-07-17T14:00:01Z'));
      acc.noteObservationFailure();
      expect(h.temp.updateCharacteristic)
        .toHaveBeenCalledWith(Characteristic.StatusActive, false);
      vi.useRealTimers();
    });

    it('recovers to active when a poll succeeds after failures', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-17T12:00:00Z'));
      const h = makeHarness(dir);
      const acc = new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');

      vi.setSystemTime(new Date('2026-07-17T15:00:00Z'));
      acc.noteObservationFailure();
      h.temp.updateCharacteristic.mockClear();

      acc.applyReading({ temperature: 20, humidity: 50, observedAt: Date.now() });
      expect(h.temp.updateCharacteristic)
        .toHaveBeenCalledWith(Characteristic.StatusActive, true);
      vi.useRealTimers();
    });

    it('expires timestamped cache values when every poll fails after restart', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-17T12:00:00Z'));
      fs.writeFileSync(cacheFile(), JSON.stringify({
        temperature: 20,
        humidity: 50,
        temperatureObservedAt: Date.now(),
        humidityObservedAt: Date.now(),
      }));
      const h = makeHarness(dir);
      const acc = new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');
      h.temp.updateCharacteristic.mockClear();

      // No applyReading ever runs; only failures.
      vi.setSystemTime(new Date('2026-07-17T14:00:01Z'));
      acc.noteObservationFailure();
      expect(h.temp.updateCharacteristic)
        .toHaveBeenCalledWith(Characteristic.StatusActive, false);
      vi.useRealTimers();
    });

    it('restores legacy cache values as inactive until a live observation arrives', () => {
      fs.writeFileSync(cacheFile(), JSON.stringify({ temperature: 20, humidity: 50 }));
      const h = makeHarness(dir);
      new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');

      expect(h.temp.updateCharacteristic)
        .toHaveBeenCalledWith(Characteristic.StatusActive, false);
      expect(h.humidity.updateCharacteristic)
        .toHaveBeenCalledWith(Characteristic.StatusActive, false);
    });

    it('clears the time-driven stale check during shutdown', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-17T12:00:00Z'));
      const h = makeHarness(dir);
      const acc = new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');

      acc.applyReading({ temperature: 20, humidity: 50, observedAt: Date.now() });
      h.temp.updateCharacteristic.mockClear();
      h.humidity.updateCharacteristic.mockClear();
      acc.shutdown();
      await vi.advanceTimersByTimeAsync(3 * HOUR);

      expect(h.temp.updateCharacteristic)
        .not.toHaveBeenCalledWith(Characteristic.StatusActive, false);
      expect(h.humidity.updateCharacteristic)
        .not.toHaveBeenCalledWith(Characteristic.StatusActive, false);
    });

    it('retries a failed stale-status update without a tight loop', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-17T12:00:00Z'));
      const h = makeHarness(dir);
      const acc = new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');
      acc.applyReading({ temperature: 20, humidity: 50, observedAt: Date.now() });

      let failOnce = true;
      h.temp.updateCharacteristic.mockImplementation((characteristic, value) => {
        if (characteristic === Characteristic.StatusActive && value === false && failOnce) {
          failOnce = false;
          throw new Error('temporary HAP failure');
        }
      });
      h.temp.updateCharacteristic.mockClear();

      await vi.advanceTimersByTimeAsync(2 * HOUR + 1);
      let attempts = h.temp.updateCharacteristic.mock.calls
        .filter((c) => c[0] === Characteristic.StatusActive && c[1] === false);
      expect(attempts).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(60 * 1000 + 1);
      attempts = h.temp.updateCharacteristic.mock.calls
        .filter((c) => c[0] === Characteristic.StatusActive && c[1] === false);
      expect(attempts).toHaveLength(2);
    });

    it('treats a valid timestamp-less measurement as fresh at receipt time', () => {
      const h = makeHarness(dir);
      const acc = new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');
      h.temp.updateCharacteristic.mockClear();

      acc.applyReading({ temperature: 20, humidity: 50, observedAt: null });
      const statusCalls = h.temp.updateCharacteristic.mock.calls
        .filter((c) => c[0] === Characteristic.StatusActive);
      expect(statusCalls).toEqual([[Characteristic.StatusActive, true]]);
    });
  });
});
