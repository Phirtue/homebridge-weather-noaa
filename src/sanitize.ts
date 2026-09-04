/**
 * Make an untrusted value safe to interpolate into a log line.
 *
 * Homebridge logs are plain text that users paste into GitHub issues and
 * Discord. Anything echoed from config.json, a cache file, or the NWS API
 * body is stripped of control characters (so it cannot fabricate log
 * lines or move the cursor) and length-capped (so it cannot flood the log).
 */
export function sanitizeForLog(value: unknown, maxLength = 64): string {
  const text = typeof value === 'string' ? value : String(value);
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}…` : clean;
}
