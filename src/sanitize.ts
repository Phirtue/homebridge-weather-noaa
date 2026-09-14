/**
 * Make an untrusted value safe to interpolate into a log line.
 *
 * Homebridge logs are plain text that users paste into GitHub issues and
 * Discord. Anything echoed from config.json, a cache file, or the NWS API
 * body is stripped of:
 *
 *  - C0/C1 control characters and DEL, so it cannot fabricate log lines,
 *    move the cursor, or inject terminal escape sequences;
 *  - Unicode bidirectional and invisible format controls (zero-width
 *    characters, RLO/LRO/PDF embedding and isolate controls, BOM), so it
 *    cannot make a log line *render* differently from how it is stored —
 *    the "Trojan Source" class of attack, which lets an attacker-supplied
 *    string visually reorder or hide the text around it;
 *
 * and then length-capped so it cannot flood the log.
 */
export function sanitizeForLog(value: unknown, maxLength = 64): string {
  const text = typeof value === 'string' ? value : String(value);
  const clean = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '');
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}…` : clean;
}
