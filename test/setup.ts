/**
 * Vitest setup, run before every test file.
 *
 * Unit tests must never reach the live NWS API. CI's egress allowlist has
 * to admit api.weather.gov for the Homebridge runtime test, so a test that
 * forgot to stub fetch would silently pass or fail on the real weather.
 * Replace the global with one that fails loudly; tests install their own
 * doubles with vi.stubGlobal('fetch', ...), and vi.unstubAllGlobals()
 * restores this guard rather than the network.
 */
globalThis.fetch = ((input: string | URL | Request): Promise<Response> => {
  const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return Promise.reject(new Error(`Unit test attempted a live fetch to ${target}; stub fetch first.`));
}) as typeof fetch;
