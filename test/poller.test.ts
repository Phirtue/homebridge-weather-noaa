import type { Logging } from 'homebridge';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NwsHttpError } from '../src/nwsClient.js';
import {
  AUTO_FAILOVER_RETRY_MS,
  isObservationFresh,
  isStationUnavailable,
  MIN_POLL_DELAY_MS,
  ObservationPoller,
  ParsedObservation,
  StationSelection,
  UnusableObservationError,
} from '../src/poller.js';
import { makeFakeLog } from './helpers.js';

const BASE_MS = 5 * 60_000;
const T0 = Date.parse('2026-09-07T15:30:00Z');

function fresh(temperature = 20, ageMs = 10 * 60_000): ParsedObservation {
  return { temperature, humidity: null, observedAt: Date.now() - ageMs };
}

function stale(): ParsedObservation {
  return { temperature: 18, humidity: null, observedAt: Date.now() - 6 * 24 * 60 * 60_000 };
}

function makeSink(applyResult = false) {
  return {
    applyReading: vi.fn(() => applyResult),
    noteObservationFailure: vi.fn(),
  };
}

function makePoller(overrides: Partial<ConstructorParameters<typeof ObservationPoller>[0]> = {}) {
  const log = makeFakeLog();
  const sink = makeSink();
  const fetchObservation = vi.fn(async () => fresh());
  const poller = new ObservationPoller({
    stationId: 'KSEA',
    sink,
    baseRefreshMs: BASE_MS,
    adaptive: false,
    log: log as Logging,
    fetchObservation,
    ...overrides,
  });
  return { poller, log, sink, fetchObservation };
}

describe('isStationUnavailable', () => {
  it('recognizes a retired station and an observation with no measurements', () => {
    expect(isStationUnavailable(new NwsHttpError(404, 'gone'))).toBe(true);
    expect(isStationUnavailable(new NwsHttpError(410, 'gone'))).toBe(true);
    expect(isStationUnavailable(new UnusableObservationError('empty'))).toBe(true);
  });

  it('treats transient failures as retryable, not as a dead station', () => {
    expect(isStationUnavailable(new NwsHttpError(403, 'forbidden'))).toBe(false);
    expect(isStationUnavailable(new Error('fetch failed'))).toBe(false);
    expect(isStationUnavailable(undefined)).toBe(false);
  });
});

describe('isObservationFresh', () => {
  it('requires a timestamp inside the staleness window', () => {
    expect(isObservationFresh({ temperature: 1, humidity: null, observedAt: T0 - 60_000 }, T0))
      .toBe(true);
    expect(isObservationFresh({ temperature: 1, humidity: null, observedAt: T0 - 3 * 3600_000 }, T0))
      .toBe(false);
    expect(isObservationFresh({ temperature: 1, humidity: null, observedAt: null }, T0))
      .toBe(false);
  });
});

describe('ObservationPoller', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('polls immediately on start and then on the base cadence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { poller, fetchObservation, sink } = makePoller();

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchObservation).toHaveBeenCalledTimes(1);
    expect(sink.applyReading).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(BASE_MS * 1.1);
    expect(fetchObservation).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it('start is idempotent and stop prevents any further polling', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { poller, fetchObservation } = makePoller();

    poller.start();
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchObservation).toHaveBeenCalledTimes(1);

    poller.stop();
    await vi.advanceTimersByTimeAsync(BASE_MS * 10);
    expect(fetchObservation).toHaveBeenCalledTimes(1);
  });

  it('never schedules below the one-minute floor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { poller, fetchObservation } = makePoller({ baseRefreshMs: 1 });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(MIN_POLL_DELAY_MS - 1000);
    expect(fetchObservation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchObservation).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it('applies the discovery observation on the first tick without a request', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const initial = fresh(12);
    const { poller, fetchObservation, sink } = makePoller({ initialObservation: initial });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchObservation).not.toHaveBeenCalled();
    expect(sink.applyReading).toHaveBeenCalledWith(initial);
    expect(poller.metrics.lastSuccessAt).toBe(T0);
    poller.stop();
  });

  it('hands a stale manual-station reading to the accessory but does not count it as a success', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    // No findReplacement: an explicitly configured station never fails over,
    // so the stale observation reaches the sink (which marks it inactive).
    const { poller, sink } = makePoller({ fetchObservation: vi.fn(async () => stale()) });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.applyReading).toHaveBeenCalledTimes(1);
    expect(poller.metrics.lastSuccessAt).toBeNull();
    poller.stop();
  });

  it('names its unusable-observation error so logs identify it', () => {
    const err = new UnusableObservationError('nothing usable');
    expect(err.name).toBe('UnusableObservationError');
    expect(String(err)).toBe('UnusableObservationError: nothing usable');
  });

  it('relaxes the cadence after repeated unchanged readings when adaptive', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // jitter factor exactly 1.0
    const { poller, fetchObservation } = makePoller({ adaptive: true });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchObservation).toHaveBeenCalledTimes(1); // t=0, streak 1
    await vi.advanceTimersByTimeAsync(BASE_MS);
    expect(fetchObservation).toHaveBeenCalledTimes(2); // t=5, streak 2
    await vi.advanceTimersByTimeAsync(BASE_MS);
    expect(fetchObservation).toHaveBeenCalledTimes(3); // t=10, streak 3 -> mult 2
    await vi.advanceTimersByTimeAsync(BASE_MS);
    expect(fetchObservation).toHaveBeenCalledTimes(3); // t=15, nothing: interval doubled
    await vi.advanceTimersByTimeAsync(BASE_MS);
    expect(fetchObservation).toHaveBeenCalledTimes(4); // t=20
    poller.stop();
  });

  it('reports a failed poll and leaves the adaptive streak alone', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const fetchObservation = vi.fn<() => Promise<ParsedObservation>>()
      .mockRejectedValueOnce(new Error('NOAA API: exhausted 4 retries'))
      .mockResolvedValue(fresh());
    const { poller, sink, log } = makePoller({ fetchObservation });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.noteObservationFailure).toHaveBeenCalledTimes(1);
    expect(sink.applyReading).not.toHaveBeenCalled();
    expect(log.messages.some((m) => m.includes('NOAA observation fetch failed'))).toBe(true);

    await vi.advanceTimersByTimeAsync(BASE_MS * 1.1);
    expect(sink.applyReading).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it('never fails over an explicitly configured station', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const fetchObservation = vi.fn(async () => stale());
    const { poller, sink } = makePoller({ fetchObservation });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    // No findReplacement: a stale reading is applied as-is; the accessory
    // owns staleness for a user-chosen station.
    expect(sink.applyReading).toHaveBeenCalledTimes(1);
    expect(poller.metrics.stationFailovers).toBe(0);
    poller.stop();
  });

  it('switches to a replacement when an auto station goes stale', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const replacement: StationSelection = { stationId: 'KPAE', observation: fresh(15) };
    const findReplacement = vi.fn(async () => replacement);
    const fetchObservation = vi.fn(async (id: string) => id === 'KSEA' ? stale() : fresh(15));
    const { poller, sink, log } = makePoller({ fetchObservation, findReplacement });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(findReplacement).toHaveBeenCalledWith('KSEA');
    expect(sink.applyReading).toHaveBeenCalledWith(replacement.observation);
    expect(sink.noteObservationFailure).not.toHaveBeenCalled();
    expect(poller.metrics.activeStationId).toBe('KPAE');
    expect(poller.metrics.stationFailovers).toBe(1);
    expect(log.messages.some((m) => m.includes('Switched NOAA station from KSEA to KPAE'))).toBe(true);

    await vi.advanceTimersByTimeAsync(BASE_MS * 1.1);
    expect(fetchObservation).toHaveBeenLastCalledWith('KPAE');
    poller.stop();
  });

  it('tells the sink which station is active on start and after failover', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const setStation = vi.fn();
    const sink = { ...makeSink(), setStation };
    const findReplacement = vi.fn(async () => ({ stationId: 'KPAE', observation: fresh() }));
    const fetchObservation = vi.fn(async (id: string) => id === 'KSEA' ? stale() : fresh());
    const { poller } = makePoller({ sink, fetchObservation, findReplacement });

    poller.start();
    expect(setStation).toHaveBeenCalledWith('KSEA');
    await vi.advanceTimersByTimeAsync(0);
    expect(setStation).toHaveBeenLastCalledWith('KPAE');
    expect(setStation).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it('fails over when the station id no longer exists (404)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const findReplacement = vi.fn(async () => ({ stationId: 'KPAE', observation: fresh() }));
    const fetchObservation = vi.fn<(id: string) => Promise<ParsedObservation>>()
      .mockRejectedValueOnce(new NwsHttpError(404, 'NOAA API 404'));
    const { poller, sink } = makePoller({ fetchObservation, findReplacement });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(findReplacement).toHaveBeenCalledTimes(1);
    expect(sink.applyReading).toHaveBeenCalledTimes(1);
    expect(poller.metrics.activeStationId).toBe('KPAE');
    poller.stop();
  });

  it('does not apply stale data when no replacement exists, and searches at most hourly', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const findReplacement = vi.fn(async () => null);
    const fetchObservation = vi.fn(async () => stale());
    const { poller, sink } = makePoller({ fetchObservation, findReplacement });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(findReplacement).toHaveBeenCalledTimes(1);
    expect(sink.applyReading).not.toHaveBeenCalled();
    expect(sink.noteObservationFailure).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(AUTO_FAILOVER_RETRY_MS - 60_000);
    expect(findReplacement).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(findReplacement).toHaveBeenCalledTimes(2);
    expect(sink.applyReading).not.toHaveBeenCalled();
    poller.stop();
  });

  it('returns to the normal cadence when the station recovers after a failed search', async () => {
    // Regression for v1.10.4 (fixed in 1.10.5): an expired failover
    // cooldown collapsed the poll delay to 1 ms once the station came back.
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    let isStale = true;
    const findReplacement = vi.fn(async () => null);
    const fetchObservation = vi.fn(async () => isStale ? stale() : fresh());
    const { poller, sink } = makePoller({ fetchObservation, findReplacement });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(findReplacement).toHaveBeenCalledTimes(1);

    isStale = false;
    await vi.advanceTimersByTimeAsync(AUTO_FAILOVER_RETRY_MS + 2 * 60_000);
    expect(sink.applyReading).toHaveBeenCalled();
    const before = fetchObservation.mock.calls.length;
    await vi.advanceTimersByTimeAsync(BASE_MS * 10);
    const polls = fetchObservation.mock.calls.length - before;
    expect(polls).toBeGreaterThanOrEqual(8);
    expect(polls).toBeLessThanOrEqual(12);
    expect(findReplacement).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it('drops an in-flight result and does not reschedule after stop', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    let release: ((o: ParsedObservation) => void) | undefined;
    const fetchObservation = vi.fn(() => new Promise<ParsedObservation>((r) => {
      release = r;
    }));
    const { poller, sink } = makePoller({ fetchObservation });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    release?.(fresh());
    await vi.advanceTimersByTimeAsync(BASE_MS * 5);
    expect(sink.applyReading).not.toHaveBeenCalled();
    expect(sink.noteObservationFailure).not.toHaveBeenCalled();
    expect(fetchObservation).toHaveBeenCalledTimes(1);
  });

  it('uses the injected clock for freshness and cooldown decisions', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    let clock = T0;
    const findReplacement = vi.fn(async () => null);
    // Observation is 1 hour old by the wall clock but the injected clock
    // says it is 3 hours old: the poller must trust the injected clock.
    const fetchObservation = vi.fn(async () => ({
      temperature: 20, humidity: null, observedAt: T0 - 60 * 60_000,
    }));
    const { poller, sink } = makePoller({ fetchObservation, findReplacement, now: () => clock });

    clock = T0 + 2 * 60 * 60_000;
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(findReplacement).toHaveBeenCalledTimes(1);
    expect(sink.applyReading).not.toHaveBeenCalled();
    poller.stop();
  });
});
