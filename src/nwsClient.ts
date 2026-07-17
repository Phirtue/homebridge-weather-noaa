import type { Logging } from 'homebridge';

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
 * Minimal HTTP client for the NWS API built on native fetch.
 *
 * Responsibilities:
 *  - bounded retries with exponential backoff for 5xx and network errors
 *  - 429 handling honoring a (capped) Retry-After header
 *  - streaming body reads, so the byte cap aborts oversized responses
 *    before they are buffered in memory
 *  - rejecting redirects that leave the NWS origin
 */
export class NwsClient {
  public readonly metrics = {
    apiFailures: 0,
    retryCount: 0,
    rateLimitedCount: 0,
  };

  constructor(
    private readonly log: Logging,
    private readonly userAgent: string,
  ) {}

  async fetchJson<T>(url: string): Promise<T> {
    let attempt = 0;
    let backoffMs = RATE_LIMIT_FLOOR_MS;

    while (attempt <= MAX_RETRIES) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent': this.userAgent,
            // Only advertise the format the parsing code understands.
            'Accept': 'application/geo+json',
          },
          signal: ac.signal,
          redirect: 'follow',
        });

        // Validate the post-redirect origin before acting on ANY part of the
        // response, including status codes and Retry-After headers. An
        // off-origin server must not be able to influence retry timing.
        this.assertNwsOrigin(res.url);

        if (res.ok) {
          const text = await this.readBodyCapped(res);
          return JSON.parse(text) as T;
        }

        if (res.status === 429) {
          this.metrics.rateLimitedCount++;
          const waitMs = withJitter(this.parseRetryAfter(res.headers.get('retry-after'), backoffMs));
          this.log.warn(`NOAA rate-limited (429). Waiting ${(waitMs / 1000).toFixed(1)}s.`);
          await this.sleep(waitMs);
          backoffMs = Math.min(backoffMs * 2, BACKOFF_CEILING_MS);
          attempt++;
          this.metrics.retryCount++;
          continue;
        }

        if (res.status >= 500 && res.status <= 599) {
          this.metrics.retryCount++;
          this.log.warn(
            `NOAA ${res.status}; retrying in ${(backoffMs / 1000).toFixed(1)}s.`,
          );
          await this.sleep(withJitter(backoffMs));
          backoffMs = Math.min(backoffMs * 2, BACKOFF_CEILING_MS);
          attempt++;
          continue;
        }

        this.metrics.apiFailures++;
        throw new Error(`NOAA API ${res.status} ${res.statusText} for ${url}`);
      } catch (err) {
        const isAbort = (err as { name?: string })?.name === 'AbortError';
        const code = (err as { code?: string })?.code;
        const isNetwork =
          isAbort ||
          code === 'ENOTFOUND' || code === 'ECONNRESET' ||
          code === 'ECONNREFUSED' || code === 'ETIMEDOUT' ||
          (err instanceof TypeError && /fetch failed/i.test(err.message));

        if (isNetwork && attempt < MAX_RETRIES) {
          this.metrics.retryCount++;
          this.log.warn(
            `Network error (${isAbort ? 'timeout' : (err as Error).message}); ` +
            `retrying in ${(backoffMs / 1000).toFixed(1)}s.`,
          );
          await this.sleep(withJitter(backoffMs));
          backoffMs = Math.min(backoffMs * 2, BACKOFF_CEILING_MS);
          attempt++;
          continue;
        }

        this.metrics.apiFailures++;
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }

    throw new Error(`NOAA API: exhausted ${MAX_RETRIES} retries for ${url}`);
  }

  /**
   * fetch() follows redirects transparently (the NWS API issues 301s, e.g.
   * for over-precise /points coordinates). Verify the final URL is still on
   * the NWS origin before trusting any part of the response: status code,
   * headers (Retry-After), or body.
   */
  private assertNwsOrigin(finalUrl: string): void {
    if (!finalUrl) {
      return; // no redirect information available
    }
    if (new URL(finalUrl).origin !== new URL(NWS_API_BASE).origin) {
      throw new Error(`Redirected off NWS origin to ${finalUrl}`);
    }
  }

  /**
   * Read the response body incrementally and abort as soon as the byte cap
   * is exceeded. Unlike res.text(), this never buffers an oversized payload.
   */
  private async readBodyCapped(res: Response): Promise<string> {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > RESPONSE_BYTE_CAP) {
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
    return new Promise((res) => setTimeout(res, ms));
  }
}
