import type { Logging } from 'homebridge';

import { NwsHttpError, withJitter } from './nwsClient.js';

/**
 * Observations older than this are treated as stale and the sensors are
 * marked inactive. NWS stations typically report hourly and QC processing
 * can add up to 20 minutes; two hours of silence means the station is dark
 * (AWOS sites do this routinely) and HomeKit should not present the last
 * reading as current. Shared by the poller (station freshness) and the
 * accessory (per-sensor expiry) so the two can never disagree.
 */
export const STALE_OBSERVATION_MS = 2 * 60 * 60 * 1000;

/** A single NWS observation reduced to what HomeKit needs. */
export interface ParsedObservation {
  temperature: number | null;
  humidity: number | null;
  /** Epoch ms of the observation itself, or null when NWS omits the timestamp. */
  observedAt: number | null;
}

/** A station that discovery has already confirmed has a fresh observation. */
export interface StationSelection {
  stationId: string;
  observation: ParsedObservation;
}

/** The observation parsed, but neither temperature nor humidity was usable. */
export class UnusableObservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnusableObservationError';
  }
}

/**
 * True when an error means "this station cannot serve observations", as
 * opposed to a transient NWS or network failure. Discovery uses it to move
 * on to the next candidate; the poller uses it to trigger a replacement
 * search. A 404/410 from the observation endpoint means the station id no
 * longer exists (NWS retires stations); a parsed body with no usable
 * measurements means it exists but reports nothing HomeKit can show.
 */
export function isStationUnavailable(err: unknown): boolean {
  return (
    err instanceof UnusableObservationError ||
    (err instanceof NwsHttpError && (err.status === 404 || err.status === 410))
  );
}

/**
 * An observation is fresh when it carries a timestamp within the staleness
 * window. One without a timestamp is not: the accessory could only expire
 * it by receipt time, which would present a dark station's last reading as
 * current for two more hours.
 */
export function isObservationFresh(observation: ParsedObservation, now = Date.now()): boolean {
  return (
    observation.observedAt !== null &&
    now - observation.observedAt <= STALE_OBSERVATION_MS
  );
}

const ADAPTIVE_GROW_AFTER_UNCHANGED = 3;
const ADAPTIVE_MAX_MULT = 4;

/**
 * After a replacement search fails, do not search again for an hour: the
 * search itself is three or more requests, and a region-wide NWS outage
 * would otherwise have every install re-probing every poll.
 */
export const AUTO_FAILOVER_RETRY_MS = 60 * 60_000;

/**
 * Absolute floor for any scheduled poll delay. Every schedule computation
 * clamps to this so no arithmetic mistake (a cooldown deadline that has
 * already passed, a negative remainder) can collapse the interval to
 * milliseconds and turn the plugin into a request loop against the free
 * NWS API. v1.10.4 shipped exactly that failure mode.
 */
export const MIN_POLL_DELAY_MS = 60_000;

/** The accessory surface the poller drives. */
export interface ReadingSink {
  /** Returns true when a characteristic changed meaningfully. */
  applyReading(observation: ParsedObservation): boolean;
  /** A poll produced nothing usable; re-evaluate staleness now. */
  noteObservationFailure(): void;
  /** The station now feeding readings: on start and after every failover. */
  setStation?(stationId: string): void;
}

export interface PollerMetrics {
  /** Station currently being polled; changes only through failover. */
  activeStationId: string;
  /** Number of times the poller switched to a replacement station. */
  stationFailovers: number;
  /**
   * Epoch ms when a fresh observation last reached HomeKit, or null if none
   * yet. A stale reading from an explicitly configured station is still
   * handed to the accessory (which marks it inactive) but is not a success.
   */
  lastSuccessAt: number | null;
}

export interface PollerOptions {
  stationId: string;
  sink: ReadingSink;
  baseRefreshMs: number;
  adaptive: boolean;
  log: Logging;
  fetchObservation: (stationId: string) => Promise<ParsedObservation>;
  /**
   * Present only for auto-discovered stations. Called with the station to
   * exclude; resolves to a replacement with a fresh observation or null.
   * An explicitly configured station never fails over: the user asked for
   * that station and silently substituting another would be a surprise.
   */
  findReplacement?: (excludeStationId: string) => Promise<StationSelection | null>;
  /** Observation already fetched during discovery; applied on the first tick. */
  initialObservation?: ParsedObservation | null;
  /** Clock, injectable for tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Owns the observation polling loop for one accessory.
 *
 * State machine per tick:
 *
 *   fetch (or use the discovery observation)
 *     ├─ fresh              → apply, clear failover cooldown
 *     ├─ stale (auto)       → replacement search (≤ once/hour) → apply or note failure
 *     ├─ unavailable (auto) → replacement search (≤ once/hour) → apply or log + note failure
 *     └─ any other error    → log + note failure (adaptive streak untouched)
 *   then schedule the next tick
 *
 * Scheduling: base interval × adaptive multiplier, ±10% jitter, capped by a
 * pending failover cooldown deadline (only if still in the future), and
 * never below MIN_POLL_DELAY_MS.
 *
 * All timers are unref()'d so they never keep the process alive; stop()
 * clears the pending timer and makes every in-flight continuation a no-op.
 */
export class ObservationPoller {
  public readonly metrics: PollerMetrics;

  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private stopped = false;
  private inFlight = false;
  private pendingObservation: ParsedObservation | null;
  private nextFailoverAttemptAt = 0;
  private unchangedStreak = 0;
  private readonly now: () => number;

  constructor(private readonly opts: PollerOptions) {
    this.pendingObservation = opts.initialObservation ?? null;
    this.now = opts.now ?? Date.now;
    this.metrics = {
      activeStationId: opts.stationId,
      stationFailovers: 0,
      lastSuccessAt: null,
    };
  }

  /** Begin polling immediately. Idempotent: only one timer chain can exist. */
  start(): void {
    if (this.started || this.stopped) {
      return;
    }
    this.started = true;
    this.opts.sink.setStation?.(this.metrics.activeStationId);
    this.tick().catch((err) => {
      if (!this.stopped) {
        this.opts.log.error('Initial tick error:', err);
      }
    });
  }

  /** Stop polling. Safe to call more than once and before start(). */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) {
      return;
    }
    let mult = 1;
    if (this.opts.adaptive && this.unchangedStreak >= ADAPTIVE_GROW_AFTER_UNCHANGED) {
      mult = Math.min(
        ADAPTIVE_MAX_MULT,
        1 + Math.floor(this.unchangedStreak / ADAPTIVE_GROW_AFTER_UNCHANGED),
      );
    }
    let delay = withJitter(this.opts.baseRefreshMs * mult);
    const now = this.now();
    if (this.nextFailoverAttemptAt > now) {
      // A relaxed adaptive schedule can be several days long. Keep failed
      // station replacement attempts on their own one-hour ceiling. Only a
      // deadline still in the future may shorten the delay; a passed one
      // must never do so.
      delay = Math.min(delay, this.nextFailoverAttemptAt - now);
    }
    delay = Math.max(delay, MIN_POLL_DELAY_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick().catch((err) => this.opts.log.error('Tick error:', err));
    }, delay);
    this.timer.unref();
  }

  /**
   * Try to switch to a replacement station. Returns the applyReading result
   * on success, or null when no search was made or it found nothing.
   */
  private async tryFailover(reason: string): Promise<boolean | null> {
    if (!this.opts.findReplacement || this.stopped || this.now() < this.nextFailoverAttemptAt) {
      return null;
    }
    this.nextFailoverAttemptAt = this.now() + AUTO_FAILOVER_RETRY_MS;
    const previous = this.metrics.activeStationId;
    this.opts.log.warn(
      `Auto-selected NOAA station ${previous} ${reason}; looking for a replacement.`,
    );
    const replacement = await this.opts.findReplacement(previous);
    if (!replacement || this.stopped) {
      return null;
    }
    this.opts.log.info(`Switched NOAA station from ${previous} to ${replacement.stationId}.`);
    this.metrics.activeStationId = replacement.stationId;
    this.metrics.stationFailovers++;
    this.nextFailoverAttemptAt = 0;
    this.opts.sink.setStation?.(replacement.stationId);
    return this.apply(replacement.observation);
  }

  private apply(observation: ParsedObservation): boolean {
    const now = this.now();
    if (isObservationFresh(observation, now)) {
      this.metrics.lastSuccessAt = now;
    }
    return this.opts.sink.applyReading(observation);
  }

  private async tick(): Promise<void> {
    if (this.inFlight || this.stopped) {
      return;
    }
    this.inFlight = true;
    try {
      const observation =
        this.pendingObservation ??
        await this.opts.fetchObservation(this.metrics.activeStationId);
      this.pendingObservation = null;
      if (this.stopped) {
        return;
      }
      if (this.opts.findReplacement && !isObservationFresh(observation, this.now())) {
        const failoverChanged = await this.tryFailover('is stale');
        if (this.stopped) {
          return;
        }
        if (failoverChanged === null) {
          // Never replace a last-known-good value with data already known
          // to be stale. The accessory will independently expire the
          // retained value according to its original observation time.
          this.opts.sink.noteObservationFailure();
          return;
        }
        this.unchangedStreak = failoverChanged ? 0 : this.unchangedStreak + 1;
        return;
      }

      // The station is healthy again (or never left): clear any pending
      // replacement-search cooldown so it cannot keep shaping the schedule.
      this.nextFailoverAttemptAt = 0;
      const changed = this.apply(observation);
      this.unchangedStreak = changed ? 0 : this.unchangedStreak + 1;
    } catch (err) {
      if (this.stopped) {
        return;
      }
      const failoverChanged = isStationUnavailable(err)
        ? await this.tryFailover('has no usable observation')
        : null;
      if (this.stopped) {
        return;
      }
      if (failoverChanged !== null) {
        this.unchangedStreak = failoverChanged ? 0 : this.unchangedStreak + 1;
      } else {
        this.opts.log.error('NOAA observation fetch failed:', (err as Error).message);
        // A failed poll is not a value change: leave the adaptive streak
        // alone. Resetting it here snapped a relaxed schedule back to the
        // fastest polling rate for the entire duration of an NWS outage —
        // maximum load aimed at a service that is already struggling.
        // Failed polls also never reach applyReading, so staleness must be
        // re-evaluated here or an extended outage leaves sensors active.
        this.opts.sink.noteObservationFailure();
      }
    } finally {
      this.inFlight = false;
      if (!this.stopped) {
        this.scheduleNext();
      }
    }
  }
}
