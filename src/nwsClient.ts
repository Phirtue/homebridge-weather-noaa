import type { Logging } from 'homebridge';

import { sanitizeForLog } from './sanitize.js';

/** Base URL for all NWS API requests. Redirects leaving this origin are rejected. */
export const NWS_API_BASE = 'https://api.weather.gov';

const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_BYTE_CAP = 2_000_000;

/**
 * NWS rate-limit guidance: requests "may be retried after the limit clears
 * (typically within 5 seconds)". We anchor the backoff floor accordingly.
 * https://www.weather.gov/documentation/services-web-api
 */
const RATE_LIMIT_FLOOR_MS = 5_000;
const BACKOFF_CEILING_MS = 60_000;
const RETRY_AFTER_CAP_MS = 5 * 60_000;
const MAX_RETRIES = 4;
const MAX_REDIRECTS = 3;

/**
 * Longest URL fragment an error message may carry. After a same-origin
 * redirect the request target is the server's Location header, which is
 * bounded only by undici's header limit; a log line should not be.
 */
const MAX_URL_LOG_CHARS = 200;

/**
 * Strip the coordinates from a /points URL before it reaches a log line.
 * The user's coordinates are the most sensitive value this plugin handles;
 * an error message that embeds them ends up in Homebridge logs that get
 * pasted into GitHub issues. Station and grid paths carry only public NWS
 * identifiers and are left intact. Output is length-capped.
 */
export function describeUrl(url: string): string {
  const described = url.replace(/\/points\/[^/?#]*/, '/points/<coordinates>');
  return described.length > MAX_URL_LOG_CHARS
    ? `${described.slice(0, MAX_URL_LOG_CHARS)}…`
    : described;
}

/**
 * Randomize a delay to +/-10% so the whole install base does not retry
 * (or poll) in lockstep after an NWS outage. Deterministic schedules
 * synchronize across users because everyone's timer starts at the same
 * event: the service coming back.
 */
export function withJitter(ms: number): number {
  return Math.round(ms * (0.9 + Math.random() * 0.2));
}

/**
 * Randomize a delay to +0..10% only. Used where the delay is a floor the
 * server set (Retry-After): desynchronize the install base without ever
 * retrying before the server said the limit clears.
 */
export function withUpwardJitter(ms: number): number {
  return Math.round(ms * (1 + Math.random() * 0.1));
}

/** Non-retryable HTTP response, exposed so station discovery can skip a 404. */
export class NwsHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'NwsHttpError';
  }
}

/**
 * Minimal HTTP client for the NWS API built on native fetch.
 *
 * Responsibilities:
 *  - bounded retries with exponential backoff for 5xx and network errors
 *  - 429 handling honoring a (capped) Retry-After header
 *  - streaming body reads, so the byte cap aborts oversized responses
 *    before they are buffered in memory
 *  - manual redirect handling: a redirect target is checked against the
 *    NWS origin BEFORE any request is issued to it, so no header (the
 *    User-Agent carries the user's optional contact) ever leaves the origin
 */
export class NwsClient {
  public readonly metrics = {
    apiFailures: 0,
    retryCount: 0,
    rateLimitedCount: 0,
  };
  private readonly activeRequests = new Set<AbortController>();
  private readonly retrySleeps = new Map<NodeJS.Timeout, () => void>();
  private shuttingDown = false;

  constructor(
    private readonly log: Logging,
    private readonly userAgent: string,
  ) {}

  /**
   * Abort active I/O and release retry sleeps during Homebridge shutdown.
   * A settled sleep unblocks fetchJson, whose shutdown check prevents the
   * retry loop from issuing another request.
   */
  shutdown(): void {
    this.shuttingDown = true;
    for (const controller of this.activeRequests) {
      controller.abort();
    }
    for (const finish of [...this.retrySleeps.values()]) {
      finish();
    }
  }

  async fetchJson<T>(url: string): Promise<T> {
    this.assertNwsOrigin(url);
    let target = url;
    let redirects = 0;
    let attempt = 0;
    let backoffMs = RATE_LIMIT_FLOOR_MS;

    while (attempt <= MAX_RETRIES) {
      if (this.shuttingDown) {
        throw new Error('NOAA client is shut down');
      }
      const ac = new AbortController();
      this.activeRequests.add(ac);
      const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch(target, {
          method: 'GET',
          headers: {
            'User-Agent': this.userAgent,
            // Only advertise the format the parsing code understands.
            'Accept': 'application/geo+json',
          },
          signal: ac.signal,
          redirect: 'manual',
        });

        // Belt and braces: with redirect: 'manual' the response URL is the
        // one we requested, which was origin-checked before the request.
        // Verify anyway before acting on ANY part of the response, so a
        // future change to redirect handling cannot silently regress this.
        try {
          this.assertNwsOrigin(res.url);
        } catch (originErr) {
          this.discardBody(res);
          throw originErr;
        }

        if (res.status >= 300 && res.status <= 399) {
          // The NWS API issues 301s (e.g. for over-precise /points
          // coordinates). Resolve the target and check its origin BEFORE
          // re-issuing; a redirect hop is not a retry attempt.
          this.discardBody(res);
          const location = res.headers.get('location');
          if (!location) {
            throw new Error(`NOAA API ${res.status} without Location for ${describeUrl(target)}`);
          }
          const next = new URL(location, target);
          this.assertNwsOrigin(next.href);
          if (++redirects > MAX_REDIRECTS) {
            throw new Error(`NOAA API: more than ${MAX_REDIRECTS} redirects for ${describeUrl(url)}`);
          }
          target = next.href;
          continue;
        }

        if (res.ok) {
          const text = await this.readBodyCapped(res);
          try {
            return JSON.parse(text) as T;
          } catch {
            // Modern V8 syntax errors can quote part of the body. Do not
            // propagate server-controlled response text into Homebridge logs.
            throw new Error(`NOAA API returned invalid JSON for ${describeUrl(target)}`);
          }
        }

        if (res.status === 429) {
          this.discardBody(res);
          this.metrics.rateLimitedCount++;
          if (attempt >= MAX_RETRIES) {
            break; // exhausted: throw below rather than sleep a backoff first
          }
          // Retry-After is the server's instruction, not a suggestion:
          // jitter only upward so the retry never lands inside the limit
          // window it was told about, and re-apply the cap afterwards.
          const waitMs = Math.min(
            RETRY_AFTER_CAP_MS,
            withUpwardJitter(this.parseRetryAfter(res.headers.get('retry-after'), backoffMs)),
          );
          this.metrics.retryCount++;
          this.log.warn(`NOAA rate-limited (429). Waiting ${(waitMs / 1000).toFixed(1)}s.`);
          await this.sleep(waitMs);
          backoffMs = Math.min(backoffMs * 2, BACKOFF_CEILING_MS);
          attempt++;
          continue;
        }

        if (res.status >= 500 && res.status <= 599) {
          this.discardBody(res);
          if (attempt >= MAX_RETRIES) {
            break; // exhausted: throw below rather than sleep a backoff first
          }
          this.metrics.retryCount++;
          const waitMs = withJitter(backoffMs);
          this.log.warn(`NOAA ${res.status}; retrying in ${(waitMs / 1000).toFixed(1)}s.`);
          await this.sleep(waitMs);
          backoffMs = Math.min(backoffMs * 2, BACKOFF_CEILING_MS);
          attempt++;
          continue;
        }

        // No apiFailures++ here: the catch below counts this throw, and
        // incrementing in both places double-counted non-retryable errors.
        this.discardBody(res);
        const status = res.statusText
          ? `${res.status} ${sanitizeForLog(res.statusText, 64)}`
          : String(res.status);
        throw new NwsHttpError(
          res.status,
          `NOAA API ${status} for ${describeUrl(target)}`,
        );
      } catch (err) {
        if (this.shuttingDown) {
          throw new Error('NOAA client is shut down', { cause: err });
        }
        const isAbort = (err as { name?: string })?.name === 'AbortError';
        const code = (err as { code?: string })?.code;
        const causeCode = (err as { cause?: { code?: string } })?.cause?.code;
        const isNetwork =
          isAbort ||
          code === 'ENOTFOUND' || code === 'ECONNRESET' ||
          code === 'ECONNREFUSED' || code === 'ETIMEDOUT' ||
          (typeof causeCode === 'string' && causeCode.startsWith('UND_ERR_')) ||
          (err instanceof TypeError && /fetch failed|terminated/i.test(err.message));

        if (isNetwork && attempt < MAX_RETRIES) {
          this.metrics.retryCount++;
          const message = sanitizeForLog(
            describeUrl(String((err as Error).message ?? 'request failed')),
            120,
          );
          const waitMs = withJitter(backoffMs);
          this.log.warn(
            `Network error (${isAbort ? 'timeout' : message}); ` +
            `retrying in ${(waitMs / 1000).toFixed(1)}s.`,
          );
          await this.sleep(waitMs);
          backoffMs = Math.min(backoffMs * 2, BACKOFF_CEILING_MS);
          attempt++;
          continue;
        }

        this.metrics.apiFailures++;
        throw err;
      } finally {
        clearTimeout(timer);
        this.activeRequests.delete(ac);
      }
    }

    // This throw is outside the try/catch, so the catch block's counter
    // never sees it; count it here or exhausted 429/5xx sequences would
    // appear in retryCount but not apiFailures.
    this.metrics.apiFailures++;
    throw new Error(`NOAA API: exhausted ${MAX_RETRIES} retries for ${describeUrl(target)}`);
  }

  /**
   * Every URL this client requests — the caller's, and every redirect
   * target — must be on the NWS origin. Redirects are handled manually
   * (see fetchJson), so this runs BEFORE a request is issued and nothing,
   * headers included, is ever sent to a foreign host. Only the offending
   * origin is reported; the full URL could carry the user's coordinates.
   */
  private assertNwsOrigin(candidate: string): void {
    if (!candidate) {
      return; // test doubles may omit the response URL
    }
    const origin = new URL(candidate).origin;
    if (origin !== new URL(NWS_API_BASE).origin) {
      throw new Error(`Redirected off NWS origin to ${origin}`);
    }
  }

  /**
   * Non-OK responses are acted on via status/headers only; cancel the body
   * so undici can release the stream and reuse the connection instead of
   * holding both until GC. cancel() on a locked or errored stream rejects
   * rather than throwing, so the swallow below covers every case.
   */
  private discardBody(res: Response): void {
    void res.body?.cancel().catch(() => { /* ignore */ });
  }

  /**
   * Read the response body incrementally and abort as soon as the byte cap
   * is exceeded. Unlike res.text(), this never buffers an oversized payload.
   */
  private async readBodyCapped(res: Response): Promise<string> {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > RESPONSE_BYTE_CAP) {
      await res.body?.cancel().catch(() => { /* ignore */ });
      throw new Error(`Response Content-Length ${declared} exceeds ${RESPONSE_BYTE_CAP} byte cap`);
    }
    if (!res.body) {
      return '';
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      received += value.byteLength;
      if (received > RESPONSE_BYTE_CAP) {
        await reader.cancel();
        throw new Error(`Response exceeded ${RESPONSE_BYTE_CAP} byte cap`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private parseRetryAfter(header: string | null, fallbackMs: number): number {
    if (!header) {
      return fallbackMs;
    }
    const asInt = Number(header);
    if (Number.isFinite(asInt) && asInt >= 0) {
      return Math.min(Math.max(asInt * 1000, RATE_LIMIT_FLOOR_MS), RETRY_AFTER_CAP_MS);
    }
    const asDate = Date.parse(header);
    if (!Number.isNaN(asDate)) {
      const delta = asDate - Date.now();
      if (delta > 0) {
        return Math.min(Math.max(delta, RATE_LIMIT_FLOOR_MS), RETRY_AFTER_CAP_MS);
      }
    }
    return fallbackMs;
  }

  private sleep(ms: number): Promise<void> {
    if (this.shuttingDown) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const sleeps = this.retrySleeps;
      const state: { timer?: NodeJS.Timeout } = {};
      const finish = (): void => {
        if (state.timer) {
          clearTimeout(state.timer);
          sleeps.delete(state.timer);
        }
        resolve();
      };
      const timer = setTimeout(finish, ms);
      state.timer = timer;
      timer.unref();
      sleeps.set(timer, finish);
    });
  }
}
