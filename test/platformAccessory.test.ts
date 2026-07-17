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
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const cacheFile = () => path.join(dir, 'noaa-weather-last.json');

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

  it('clamps out-of-range temperatures to the HomeKit range', () => {
    const h = makeHarness(dir);
    const acc = new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');

    acc.applyReading({ temperature: 150, humidity: null });
    expect(h.temp.updateCharacteristic)
      .toHaveBeenCalledWith(Characteristic.CurrentTemperature, 100);
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

  describe('staleness', () => {
    const HOUR = 60 * 60 * 1000;

    it('marks sensors inactive when the observation is older than 2 hours', () => {
      const h = makeHarness(dir);
      const acc = new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');

      acc.applyReading({ temperature: 20, humidity: 50, observedAt: Date.now() - 3 * HOUR });
      expect(h.temp.updateCharacteristic)
        .toHaveBeenCalledWith(Characteristic.StatusActive, false);
      expect(h.humidity.updateCharacteristic)
        .toHaveBeenCalledWith(Characteristic.StatusActive, false);
      expect(h.log.messages.some((m) => m.includes('stale'))).toBe(true);
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
      expect(statusCalls).toHaveLength(0);
    });

    it('leaves staleness untouched when the timestamp is absent', () => {
      const h = makeHarness(dir);
      const acc = new NOAAWeatherAccessory(h.platform, h.accessory, '0.0.0');
      h.temp.updateCharacteristic.mockClear();

      acc.applyReading({ temperature: 20, humidity: 50, observedAt: null });
      const statusCalls = h.temp.updateCharacteristic.mock.calls
        .filter((c) => c[0] === Characteristic.StatusActive);
      expect(statusCalls).toHaveLength(0);
    });
  });
});
