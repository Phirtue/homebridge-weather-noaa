import { describe, expect, it } from 'vitest';

import { sanitizeForLog } from '../src/sanitize.js';

describe('sanitizeForLog', () => {
  it('passes ordinary text through unchanged', () => {
    expect(sanitizeForLog('wmoUnit:degC')).toBe('wmoUnit:degC');
    expect(sanitizeForLog('Light Rain, Fog/Mist')).toBe('Light Rain, Fog/Mist');
  });

  it('strips CR/LF and other control characters', () => {
    expect(sanitizeForLog('a\r\n[error] forged line\tb\u001b[31m')).toBe('a[error] forged lineb[31m');
    expect(sanitizeForLog('x\u0000y\u007fz\u0085w')).toBe('xyzw');
  });

  it('strips bidirectional and invisible format controls (Trojan Source)', () => {
    // RLO/PDF embedding, LRI/PDI isolates, zero-width chars, BOM, and the
    // Unicode line/paragraph separators.
    expect(sanitizeForLog('KSEA\u202e\u2066 stale\u2069\u202c'))
      .toBe('KSEA stale');
    expect(sanitizeForLog('a\u200bb\u200cc\u200dd\u2060e\ufefff')).toBe('abcdef');
    expect(sanitizeForLog('line1\u2028[error] forged\u2029line2')).toBe('line1[error] forgedline2');
  });

  it('strips every Unicode format character, not just a hand-picked list', () => {
    // Arabic letter mark (a Bidi_Control the old range missed), soft
    // hyphen, interlinear annotation anchor, Mongolian vowel separator,
    // and a tag-block character used to hide text.
    expect(sanitizeForLog('KSEA\u061c stale')).toBe('KSEA stale');
    expect(sanitizeForLog('a\u00adb\ufff9c\u180ed\u{e0041}e')).toBe('abcde');
  });

  it('drops lone surrogates but keeps paired ones', () => {
    expect(sanitizeForLog('a\ud83db')).toBe('ab');
    expect(sanitizeForLog('a😀b')).toBe('a😀b');
  });

  it('truncates on code point boundaries so a surrogate pair is never split', () => {
    const out = sanitizeForLog(`${'x'.repeat(63)}😀tail`, 64);
    expect(out).toBe(`${'x'.repeat(63)}😀…`);
    expect(/\p{Cs}/u.test(out)).toBe(false); // no lone surrogate left behind
  });

  it('leaves ordinary non-ASCII text alone', () => {
    expect(sanitizeForLog('Ångström 20°C — Zürich')).toBe('Ångström 20°C — Zürich');
  });

  it('caps the length and marks the truncation', () => {
    const out = sanitizeForLog('x'.repeat(500), 64);
    expect(out).toHaveLength(65);
    expect(out.endsWith('…')).toBe(true);
    expect(sanitizeForLog('x'.repeat(64), 64)).toHaveLength(64);
  });

  it('stringifies non-string input', () => {
    expect(sanitizeForLog(42)).toBe('42');
    expect(sanitizeForLog(undefined)).toBe('undefined');
  });
});
