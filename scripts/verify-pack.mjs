// Assert the exact npm tarball contents against the checked-in
// manifest (.github/expected-package-files.txt). Run after a build:
//   node scripts/verify-pack.mjs
// Exits non-zero on any drift, listing unexpected and missing files.
// Node built-ins only — this repository ships zero runtime dependencies
// and its tooling scripts follow the same rule.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const expected = readFileSync(join(root, '.github', 'expected-package-files.txt'), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'))
  .sort();

const packOutput = execFileSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: root,
  encoding: 'utf8',
  // npm prints notices to stderr; only stdout carries the JSON.
  stdio: ['ignore', 'pipe', 'inherit'],
});
const actual = JSON.parse(packOutput)[0].files.map((f) => f.path).sort();

const expectedSet = new Set(expected);
const actualSet = new Set(actual);
const unexpected = actual.filter((f) => !expectedSet.has(f));
const missing = expected.filter((f) => !actualSet.has(f));

if (unexpected.length === 0 && missing.length === 0) {
  console.log(`Package contents verified: ${actual.length} files match the manifest.`);
  process.exit(0);
}

if (unexpected.length > 0) {
  console.error('Files in the tarball but NOT in .github/expected-package-files.txt:');
  for (const f of unexpected) {
    console.error(`  + ${f}`);
  }
}
if (missing.length > 0) {
  console.error('Files in .github/expected-package-files.txt but NOT in the tarball:');
  for (const f of missing) {
    console.error(`  - ${f}`);
  }
}
console.error(
  'Tarball contents drifted from the manifest. If the change is intentional, ' +
  'update .github/expected-package-files.txt in the same PR.',
);
process.exit(1);
