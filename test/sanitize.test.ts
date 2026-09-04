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
