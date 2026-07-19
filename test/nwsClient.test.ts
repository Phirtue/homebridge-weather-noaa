import { afterEach, describe, expect, it, vi } from 'vitest';

import { NwsClient, withJitter } from '../src/nwsClient.js';
import { fakeResponse, makeFakeLog } from './helpers.js';

const URL_OK = 'https://api.weather.gov/points/47.6204,-122.3494';

function makeClient() {
  const log = makeFakeLog();
  return { client: new NwsClient(log, 'test-agent'), log };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('withJitter', () => {
  it('stays within +/-10% of the input', () => {
    for (let i = 0; i < 1000; i++) {
      const v = withJitter(10_000);
      expect(v).toBeGreaterThanOrEqual(9_000);
      expect(v).toBeLessThanOrEqual(11_000);
    }
  });
});

describe('fetchJson', () => {
  it('parses a successful on-origin response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      fakeResponse({ url: URL_OK, body: JSON.stringify({ a: 1 }) }),
    ));
    const { client } = makeClient();
    await expect(client.fetchJson(URL_OK)).resolves.toEqual({ a: 1 });
  });

  it('rejects an off-origin redirect on a success response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      fakeResponse({ url: 'https://evil.example/x', body: '{}' }),
    ));
    const { client } = makeClient();
    await expect(client.fetchJson(URL_OK)).rejects.toThrow(/Redirected off NWS origin/);
  });

  it('rejects an off-origin redirect on a 429 before honoring Retry-After', async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse({
        url: 'https://evil.example/x',
        status: 429,
        headers: { 'retry-after': '300' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { client } = makeClient();

    const started = Date.now();
    await expect(client.fetchJson(URL_OK)).rejects.toThrow(/Redirected off NWS origin/);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.metrics.rateLimitedCount).toBe(0);
  });

  it('retries a 429 honoring Retry-After, then succeeds', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(fakeResponse({
        url: URL_OK, status: 429, headers: { 'retry-after': '7' },
      }))
      .mockResolvedValueOnce(fakeResponse({ url: URL_OK, body: '{"ok":true}' }));
    vi.stubGlobal('fetch', fetchMock);
    const { client } = makeClient();

    const promise = client.fetchJson(URL_OK);
    await vi.advanceTimersByTimeAsync(8_000); // 7s +10% jitter max = 7.7s
    await expect(promise).resolves.toEqual({ ok: true });
    expect(client.metrics.rateLimitedCount).toBe(1);
    expect(client.metrics.retryCount).toBe(1);
  });

  it('retries 5xx with backoff and gives up after exhausting retries', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => fakeResponse({ url: URL_OK, status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const { client } = makeClient();

    const promise = client.fetchJson(URL_OK);
    // Suppress unhandled rejection noise while timers advance.
    const settled = promise.catch((err: Error) => err);
    // Backoffs between the 5 attempts: 5, 10, 20, 40s, +10% jitter margin.
    // No sleep follows the final failed attempt.
    await vi.advanceTimersByTimeAsync(90_000);
    const result = await settled;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/exhausted 4 retries/);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    // Exhaustion is one logical failure counted once in apiFailures;
    // retryCount reflects the 4 retries that actually happened.
    expect(client.metrics.apiFailures).toBe(1);
    expect(client.metrics.retryCount).toBe(4);
  });

  it('fails immediately on non-retryable status codes', async () => {
    const fetchMock = vi.fn(async () => fakeResponse({ url: URL_OK, status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const { client } = makeClient();

    await expect(client.fetchJson(URL_OK)).rejects.toThrow(/NOAA API 404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.metrics.apiFailures).toBe(1);
  });

  it('rejects oversized bodies via the streaming byte cap', async () => {
    const big = 'x'.repeat(2_000_001);
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ url: URL_OK, body: big })));
    const { client } = makeClient();
    await expect(client.fetchJson(URL_OK)).rejects.toThrow(/exceeded 2000000 byte cap/);
  });

  it('rejects oversized declared Content-Length before reading', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      fakeResponse({
        url: URL_OK, body: '{}', headers: { 'content-length': '99999999' },
      }),
    ));
    const { client } = makeClient();
    await expect(client.fetchJson(URL_OK)).rejects.toThrow(/Content-Length 99999999 exceeds/);
  });
});

describe('body discard on non-OK responses', () => {
  // fakeResponse builds plain objects, so the body can be swapped for a
  // cancel spy. An unconsumed body keeps the undici connection out of the
  // keep-alive pool until GC; every branch that skips reading must cancel.
  const withCancelSpy = (res: Response) => {
    const cancel = vi.fn(async () => undefined);
    (res as unknown as { body: unknown }).body = { cancel };
    return cancel;
  };

  it('cancels a 429 body before sleeping for the retry', async () => {
    vi.useFakeTimers();
    const res429 = fakeResponse({ url: URL_OK, status: 429, headers: { 'retry-after': '5' } });
    const cancel = withCancelSpy(res429);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res429)
      .mockResolvedValueOnce(fakeResponse({ url: URL_OK, body: '{"ok":true}' }));
    vi.stubGlobal('fetch', fetchMock);
    const { client } = makeClient();

    const promise = client.fetchJson(URL_OK);
    await vi.advanceTimersByTimeAsync(0); // run the 429 branch up to its sleep
    expect(cancel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6_000); // 5s floor +10% jitter max
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('cancels a 5xx body before sleeping for the retry', async () => {
    vi.useFakeTimers();
    const res500 = fakeResponse({ url: URL_OK, status: 500 });
    const cancel = withCancelSpy(res500);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res500)
      .mockResolvedValueOnce(fakeResponse({ url: URL_OK, body: '{"ok":true}' }));
    vi.stubGlobal('fetch', fetchMock);
    const { client } = makeClient();

    const promise = client.fetchJson(URL_OK);
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('cancels the body of a non-retryable status and still throws unchanged', async () => {
    const res404 = fakeResponse({ url: URL_OK, status: 404 });
    const cancel = withCancelSpy(res404);
    vi.stubGlobal('fetch', vi.fn(async () => res404));
    const { client } = makeClient();

    await expect(client.fetchJson(URL_OK)).rejects.toThrow(/NOAA API 404 404/);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(client.metrics.apiFailures).toBe(1);
  });

  it('cancels the body of an off-origin response', async () => {
    const evil = fakeResponse({ url: 'https://evil.example/x', body: '{}' });
    const cancel = withCancelSpy(evil);
    vi.stubGlobal('fetch', vi.fn(async () => evil));
    const { client } = makeClient();

    await expect(client.fetchJson(URL_OK)).rejects.toThrow(/Redirected off NWS origin/);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('does not cancel a 200 body, which is consumed by the capped reader', async () => {
    const ok = fakeResponse({ url: URL_OK, body: '{"a":1}' });
    const cancel = vi.spyOn(ok.body!, 'cancel');
    vi.stubGlobal('fetch', vi.fn(async () => ok));
    const { client } = makeClient();

    await expect(client.fetchJson(URL_OK)).resolves.toEqual({ a: 1 });
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe('parseRetryAfter', () => {
  const { client } = makeClient();
  const parse = (header: string | null, fallback = 1_000): number =>
    (client as unknown as {
      parseRetryAfter(h: string | null, f: number): number;
    }).parseRetryAfter(header, fallback);

  it('returns the fallback when the header is missing', () => {
    expect(parse(null, 1_234)).toBe(1_234);
  });

  it('clamps numeric seconds to the 5s floor', () => {
    expect(parse('1')).toBe(5_000);
  });

  it('clamps numeric seconds to the 5 minute cap', () => {
    expect(parse('86400')).toBe(300_000);
  });

  it('accepts an HTTP-date within bounds', () => {
    const date = new Date(Date.now() + 60_000).toUTCString();
    const ms = parse(date);
    expect(ms).toBeGreaterThanOrEqual(5_000);
    expect(ms).toBeLessThanOrEqual(300_000);
  });

  it('returns the fallback for garbage values', () => {
    expect(parse('soon', 2_000)).toBe(2_000);
  });

  it('returns the fallback for a date in the past', () => {
    expect(parse(new Date(Date.now() - 60_000).toUTCString(), 3_000)).toBe(3_000);
  });
});
