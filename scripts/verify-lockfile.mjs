// Validate the committed npm lockfile before npm executes any dependency
// code. This intentionally uses Node built-ins instead of downloading a
// lockfile linter with npx: the verifier itself must not add another
// unreviewed dependency to the supply-chain boundary.
//
// Usage:
//   node scripts/verify-lockfile.mjs [path-to-package-lock.json]
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = resolve(process.argv[2] ?? join(root, 'package-lock.json'));
const errors = [];

let lock;
try {
  lock = JSON.parse(readFileSync(lockPath, 'utf8'));
} catch (err) {
  console.error(`Cannot parse ${lockPath}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

if (lock.lockfileVersion !== 3) {
  errors.push(`expected lockfileVersion 3, found ${String(lock.lockfileVersion)}`);
}
if (!lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) {
  errors.push('missing packages object');
}

for (const [location, entry] of Object.entries(lock.packages ?? {})) {
  if (location === '') {
    continue; // the repository root has no resolved tarball or integrity
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    errors.push(`${location}: package entry is not an object`);
    continue;
  }
  if (entry.link === true) {
    errors.push(`${location}: linked packages are not permitted`);
    continue;
  }
  if (typeof entry.resolved !== 'string') {
    errors.push(`${location}: missing resolved URL`);
  } else {
    try {
      const resolved = new URL(entry.resolved);
      if (
        resolved.protocol !== 'https:' ||
        resolved.hostname !== 'registry.npmjs.org' ||
        resolved.port !== '' ||
        resolved.username !== '' ||
        resolved.password !== ''
      ) {
        errors.push(`${location}: resolved URL is outside https://registry.npmjs.org`);
      }
    } catch {
      errors.push(`${location}: resolved value is not a valid URL`);
    }
  }
  if (
    typeof entry.integrity !== 'string' ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)
  ) {
    errors.push(`${location}: missing or invalid SHA-512 integrity`);
  }
}

if (errors.length > 0) {
  console.error(`Lockfile verification failed (${errors.length} issue${errors.length === 1 ? '' : 's'}):`);
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}

console.log(
  `Lockfile verified: ${Object.keys(lock.packages).length - 1} packages use ` +
  'HTTPS npm-registry URLs and SHA-512 integrity.',
);
