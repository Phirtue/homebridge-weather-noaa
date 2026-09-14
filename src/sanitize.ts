/**
 * Make an untrusted value safe to interpolate into a log line.
 *
 * Homebridge logs are plain text that users paste into GitHub issues and
 * Discord. Anything echoed from config.json, a cache file, or the NWS API
 * body is stripped of:
 *
 *  - every Unicode control character (`\p{Cc}`: C0, C1 and DEL), so it
 *    cannot fabricate log lines, move the cursor, or inject terminal
 *    escape sequences;
 *  - every Unicode format character (`\p{Cf}`: the bidirectional
 *    embedding, override and isolate controls, zero-width characters,
 *    BOM, soft hyphen, Arabic letter mark, interlinear annotation
 *    controls and the invisible tag block), so it cannot make a log line
 *    *render* differently from how it is stored — the "Trojan Source"
 *    class of attack, which lets an attacker-supplied string visually
 *    reorder or hide the text around it. The property escape is used
 *    instead of a hand-written range so nothing in the category is missed;
 *  - lone surrogates (`\p{Cs}`), which are not valid text and would be
 *    replaced by U+FFFD or worse by whatever consumes the log;
 *  - the line and paragraph separators (U+2028/2029, category Zl/Zp),
 *    which terminals and viewers may treat as line breaks;
 *
 * and then length-capped in code points, so it cannot flood the log and
 * truncation cannot split a surrogate pair.
 */
export function sanitizeForLog(value: unknown, maxLength = 64): string {
  const text = typeof value === 'string' ? value : String(value);
  const clean = text.replace(/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu, '');
  const codePoints = Array.from(clean);
  return codePoints.length > maxLength
    ? `${codePoints.slice(0, maxLength).join('')}…`
    : clean;
}
