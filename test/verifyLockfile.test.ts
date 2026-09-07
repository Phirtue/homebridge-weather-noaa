import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'verify-lockfile.mjs',
);
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function verify(packages: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noaa-lock-test-'));
  tempDirs.push(dir);
  const lock = path.join(dir, 'package-lock.json');
  fs.writeFileSync(lock, JSON.stringify({ lockfileVersion: 3, packages }));
  return spawnSync(process.execPath, [script, lock], { encoding: 'utf8' });
}

const integrity = `sha512-${'A'.repeat(86)}==`;

describe('verify-lockfile', () => {
  it('accepts registry tarballs bound to unscoped and scoped package identities', () => {
    const result = verify({
      '': {},
      'node_modules/example': {
        version: '1.2.3',
        resolved: 'https://registry.npmjs.org/example/-/example-1.2.3.tgz',
        integrity,
      },
      'node_modules/@scope/example': {
        version: '4.5.6',
        resolved: 'https://registry.npmjs.org/@scope/example/-/example-4.5.6.tgz',
        integrity,
      },
    });

    expect(result.status).toBe(0);
  });

  it('rejects a valid registry URL for a different package tarball', () => {
    const result = verify({
      '': {},
      'node_modules/example': {
        version: '1.2.3',
        resolved: 'https://registry.npmjs.org/other/-/other-1.2.3.tgz',
        integrity,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not match its package name and version');
  });

  it('rejects malformed locations, digest lengths, and URL suffixes', () => {
    const result = verify({
      '': {},
      example: {
        version: '1.2.3',
        resolved: 'https://registry.npmjs.org/example/-/example-1.2.3.tgz?mirror=1',
        integrity: 'sha512-A',
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('invalid node_modules package location');
    expect(result.stderr).toContain('outside https://registry.npmjs.org');
    expect(result.stderr).toContain('missing or invalid SHA-512 integrity');
  });
});
