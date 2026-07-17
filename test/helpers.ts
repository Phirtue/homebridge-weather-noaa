import type { Logging } from 'homebridge';
import { vi } from 'vitest';

/**
 * Minimal Logging stub. Homebridge's Logging is a callable interface with
 * level methods; tests only need the methods and a record of what was said.
 */
export interface FakeLog extends Logging {
  messages: string[];
}

export function makeFakeLog(): FakeLog {
  const messages: string[] = [];
  const record = (level: string) =>
    vi.fn((...args: unknown[]) => {
      messages.push(`[${level}] ${args.join(' ')}`);
    });
  const log = Object.assign(record('log'), {
    messages,
    prefix: 'test',
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
    log: record('log'),
    success: record('success'),
  });
  return log as unknown as FakeLog;
}

/** Build a fetch Response stand-in without depending on undici internals. */
export function fakeResponse(opts: {
  status?: number;
  url?: string;
  body?: string;
  headers?: Record<string, string>;
}): Response {
  const status = opts.status ?? 200;
  const headers = new Map(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const bodyText = opts.body ?? '';
  return {
    ok: status >= 200 && status <= 299,
    status,
    statusText: String(status),
    url: opts.url ?? 'https://api.weather.gov/test',
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    body: bodyText === '' ? null : new Blob([bodyText]).stream(),
  } as unknown as Response;
}
