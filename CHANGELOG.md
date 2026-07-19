# Changelog

## [1.9.2] - 2026-07-19

Robustness patch driven by two independent external code reviews. No
exploitable vulnerabilities were found in either review; every item
below is defensive hardening or hygiene. No config changes; existing
installs upgrade in place.

### Reliability

- **Refresh interval is now bounded (5-1440 minutes) at parse time.**
  Previously only the floor was enforced in code; a hand-edited
  `config.json` value above ~8,948 minutes would overflow Node's 32-bit
  `setTimeout` limit under the adaptive multiplier and invert into a
  continuous request loop against the NWS API. Out-of-range values are
  clamped with a warning.
- **Outages no longer accelerate polling.** A failed poll previously
  reset the adaptive-polling streak, snapping a relaxed schedule back
  to the fastest rate for the duration of an NWS outage. Failures now
  leave the schedule where it was.
- **`startPolling` is idempotent.** A guard enforces the single
  timer-chain invariant that previously relied on call-site behavior,
  removing a silent-death landmine for future refactors.

### Hygiene

- **Error response bodies are explicitly discarded.** 429, 5xx,
  non-retryable, and off-origin responses are acted on via status and
  headers only; their unread bodies kept undici connections out of the
  keep-alive pool until garbage collection. All four branches now
  cancel the body immediately.
- **Exhausted retry sequences are counted in `apiFailures`.** They
  previously appeared in `retryCount` only, understating the hourly
  metrics line. Retry exhaustion also no longer sleeps a full backoff
  before giving up.
- **Rejected `stationId` values are sanitized before being echoed** to
  the log (CR/LF stripped, length-capped), matching the convention
  already used for the User-Agent contact.
- **`noUncheckedIndexedAccess` enabled** in `tsconfig.json` for
  stricter index typing across the codebase.
- **Redirect-handling trade-off documented.** `assertNwsOrigin` now
  records that redirects are followed before the origin check runs —
  acceptable while requests carry no secrets — so any future change
  adding credentials knows to revisit the model first.

### Testing

- 10 new tests (suite now 77): refresh-interval clamping including a
  property-based `setTimeout`-overflow invariant, body-discard coverage
  for all four non-OK branches plus a 200-path regression guard,
  retry-exhaustion metrics, log sanitization, polling idempotence, and
  adaptive-schedule behavior across a failed poll.

## [1.9.1] - 2026-07-17

Documentation and release-infrastructure patch. The plugin code is
identical to 1.9.0; no config changes, existing installs upgrade in
place.

### Release verifiability

- **Signed releases.** The SBOM attached to each GitHub release now
  carries a Sigstore keyless signature, and signatures were backfilled
  onto all prior releases with SBOMs (v1.7.0 through v1.9.0).
- **SLSA build provenance.** Starting with this release, an isolated
  OpenSSF builder generates signed provenance (`.intoto.jsonl`)
  attesting exactly which commit and workflow produced the npm tarball
  and SBOM, both of which are attached to the release. Verifiable with
  `slsa-verifier`.

### Security posture

- **OpenSSF Best Practices badge (passing).** The project now holds the
  badge and displays it in the README alongside the Scorecard badge.
- **CI egress control.** Every workflow starts with StepSecurity
  harden-runner; the static workflows (CodeQL, dependency review,
  Scorecard) run in block mode with explicit endpoint allowlists.
- **Property-based tests.** A fast-check suite (11 properties, suite
  now 67 tests) fuzzes the network-facing parsing surfaces: Retry-After
  handling can never produce an unbounded wait, unit conversions never
  yield NaN, and station IDs accepted by validation are URL-inert.

### Housekeeping

- The verified-by-homebridge badge links to the new plugin directory
  location (homebridge/plugins wiki).
- The CI runtime test port moved out of the Linux ephemeral range,
  eliminating a rare EADDRINUSE flake.
- GitHub Actions bumped to current releases (checkout v7, setup-node
  v7, dependency-review v5, harden-runner v2.20), SHA-pinned as always.

## [1.9.0] - 2026-07-17

Resilience, testing, and hardening release based on two rounds of
external code review. No breaking changes and no config changes;
existing installs upgrade in place.

### Reliability

- **Startup discovery now retries.** If station discovery fails when
  Homebridge boots (for example after a power outage, when the router
  and the Homebridge host restart together and the network is not up
  yet), the plugin no longer stays inactive until a manual restart. It
  retries discovery on a doubling backoff, from 1 minute up to a
  15 minute ceiling, indefinitely, and logs each attempt.
- **Stale observations are flagged.** NWS stations sometimes go dark
  while the API keeps returning the last observation. Readings older
  than 2 hours now mark both sensors inactive via the HomeKit
  StatusActive characteristic, so automations keyed off outdoor
  readings are not acting on old data presented as current. Sensors
  recover automatically when fresh observations resume. The same
  threshold also applies when polls fail outright (network outage, DNS
  breakage), so an extended failure of any kind marks the sensors
  inactive.
- **Retry and polling jitter.** All backoff sleeps and the polling
  schedule are randomized by plus or minus 10 percent so the install
  base does not retry in lockstep after an NWS outage.
- **Fewer disk writes.** The readings cache is persisted only when a
  value actually changes, not on every poll. At the default interval
  this removes roughly 35,000 unnecessary write cycles a year on
  Raspberry Pi SD cards.

### Testing

- **Unit test suite added (Vitest, 52 tests).** Covers retry and
  backoff behavior, Retry-After clamping, the streaming byte cap,
  config validation, User-Agent sanitization, unit conversion including
  the Kelvin branch, MADIS QC filtering, station cache validation
  against tampered and expired files, cache write gating, and the
  staleness transitions. Runs in every CI matrix cell. Vitest is a
  devDependency; the published package still has zero runtime
  dependencies.
- **CI matrix cells fail honestly.** The Homebridge install step no
  longer falls back to the latest version when the requested version
  cannot be resolved, so the v1 compatibility cell can no longer
  silently test 2.x and report green.
- **Metrics fix.** Non-retryable HTTP errors were counted twice in the
  hourly failure metrics; the new tests caught it.

### Security

- **OpenSSF Scorecard.** A scheduled Scorecard workflow now audits the
  repository's security posture (including settings a code reviewer
  cannot verify from a clone, like enforced branch protection) and
  publishes the results to a public badge in the README.

### Housekeeping

- Example coordinates unified on the Space Needle in Seattle, WA.
- README now recommends running the plugin as a child bridge.
- SECURITY.md points at the latest release instead of naming a version
  that can go stale.
- Dropped the DOM lib from the TypeScript config; @types/node provides
  the fetch typings, and browser globals no longer typecheck.

### Security & hardening

- **Redirect origin check moved ahead of status handling.** The final
  post-redirect URL is now validated against `api.weather.gov` before
  any part of the response is acted on. Previously the check ran only
  for successful responses, so an off-origin redirect returning 429 or
  5xx could influence retry timing through its `Retry-After` header.
  Impact was bounded (waits are capped and no response body was ever
  trusted), but the invariant is now unconditional.
- **npm CLI pinned in the publish workflow.** The release job installed
  `npm@latest` at publish time, the only unpinned code in an otherwise
  fully SHA-pinned pipeline. It now installs an exact version
  (`npm@11.17.0`), so a compromised npm release cannot inject code into
  the publish job.

### Diagnostics

- **Missing unitCode is logged.** A temperature reading without a
  `unitCode` is still treated as Celsius (matching NWS behavior in
  practice), but the assumption is now logged once at debug level so a
  misbehaving station is diagnosable.

---

## [1.8.0] - 2026-07-16

Compatibility and test-coverage release. No functional changes to the
plugin itself.

### Compatibility

- **Node.js 26 support.** Node 26 (current since April 2026, LTS in
  October 2026) is now in the `engines` field and the CI test matrix.
  Users on Node 26 no longer see engine warnings during install.

### CI

- **Homebridge v1 test leg restored.** Since the npm `latest` tag moved
  to Homebridge 2.x, the claimed `^1.8.0` compatibility was no longer
  exercised in CI. The matrix now tests Homebridge `^1`, `latest`, and
  `beta` on every supported Node version (15 jobs).
- **Meaningful runtime assertions.** The runtime test previously only
  checked that the Homebridge process stayed alive, which passes even
  when a plugin fails to load. It now asserts that the plugin registers
  and its platform initializes, and prints the Homebridge log on failure.

### Documentation

- **README rewritten** for clarity and presentation: configuration
  reference table, feature summary, security and release-verification
  section, and consistent formatting throughout.

---

## [1.7.1] - 2026-07-15

Documentation-only release. No code changes.

- README refreshed with the v1.7.0 highlights so the npm package page
  (what the Homebridge UI shows during plugin updates) reflects the
  current release. npm renders the README bundled at publish time, so a
  new version was required to carry it.

---

## [1.7.0] - 2026-07-15

A security-focused release from a full code review against the
[homebridge-plugin-template](https://github.com/homebridge/homebridge-plugin-template)
and the [NWS OpenAPI spec](https://api.weather.gov/openapi.json).
**No breaking config changes** — existing installs upgrade in place.

### Security & hardening

- **Streamed response reads** — the 2 MB response cap is now enforced
  while the body is being read, aborting oversized payloads instead of
  buffering them fully before checking.
- **Redirect origin check** — redirects are followed but the final URL
  must remain on `api.weather.gov`, or the response is rejected.
- **Temperature clamping** — live and cached temperatures are clamped to
  HomeKit's valid range (−270..100 °C), mirroring the existing humidity
  clamp; a corrupt cache file can no longer push out-of-range values.

### Supply chain

- **npm trusted publishing** — releases are published to npm from GitHub
  Actions via OIDC with `--provenance`; no npm token exists anywhere.
- **SBOM** — a CycloneDX SBOM is generated and attached to every GitHub
  release.
- **CI hardening** — least-privilege workflow tokens, actions pinned to
  commit SHAs, `--ignore-scripts` installs, and lockfile linting
  (registry-only https sources).
- **CodeQL & dependency review** — static security analysis on every
  push/PR plus weekly, and PRs introducing dependency versions with
  known advisories are blocked.
- **Dependabot** — weekly update PRs for npm and GitHub Actions;
  dev-dependency advisories in `brace-expansion` and `js-yaml` resolved.

### NOAA / NWS correctness

- **Coordinates rounded to 4 decimals** before the `/points` call,
  avoiding the API's 301 redirect for over-precise points and keeping
  the station cache key stable.
- **`Accept: application/geo+json` only** — previously advertised
  formats the parser could not handle.
- **MADIS QC flag `G` (subjective good) accepted** alongside V/C/S/Z.

### Homebridge 2.x compatibility

- **Plugin converted to ESM** (`"type": "module"`, `nodenext` module
  resolution, type-only homebridge imports) — required to build against
  Homebridge 2.x, verified working on Homebridge 1.11 and 2.1.

### Structure & maintenance

- **`platform.ts` split** — HTTP client (retry/backoff/429) extracted to
  `nwsClient.ts` and station cache I/O to `stationCache.ts`.
- **Single typed `parseConfig()`** replaces scattered config casts.
- **Version read from `package.json`** instead of a hardcoded constant.
- **Routine per-poll logs demoted to debug**; changes remain at info.
- **Toolchain** — eslint 10, TypeScript 6; `userAgentContact` capped at
  200 chars in the config schema to match runtime sanitization.

---

## [1.6.0] - 2026-04-28

A security- and minimalism-focused refresh aligned with the current
[homebridge-plugin-template](https://github.com/homebridge/homebridge-plugin-template)
and the [NOAA / NWS API documentation](https://www.weather.gov/documentation/services-web-api).
**No breaking config changes** — existing v1.5 installs upgrade in place.

### Security & hardening

- **Input validation on `stationId`** — both manually configured and
  cache-loaded values are regex-validated (`^[A-Z0-9]{3,8}$`) before any
  URL interpolation. Defense-in-depth `encodeURIComponent` applied to all
  path components.
- **Grid response validation** — `gridId`/`gridX`/`gridY` are
  shape-validated before being interpolated into the gridpoint stations
  URL.
- **Atomic cache writes** — cache files written via temp-then-rename with
  `0o600` permissions; eliminates corruption from interrupted writes.
- **Bounded response size** — NOAA responses capped at 2 MB to defend
  against pathological payloads.
- **Bounded `Retry-After`** — server-supplied retry delays capped at
  5 minutes to prevent indefinite stalls.
- **Header-injection safe `User-Agent`** — optional `userAgentContact`
  config field is sanitized to strip CR/LF and length-capped before
  being placed in the HTTP header.
- **Coordinate range validation** at both schema and runtime
  (`-90..90` / `-180..180`).

### Minimization

- **Dropped `axios` dependency entirely** — replaced with native Node 18+
  `fetch` and `AbortController`. Zero runtime dependencies.
- **Removed self-heal recovery code** in the accessory — the previous
  `addService()` retry path could not succeed (Homebridge rejects
  duplicate subtypes). We now trust HAP-NodeJS and log-and-continue on
  rare characteristic update failures.
- **Removed `require_qc=true` query parameter** — verified against the
  NOAA OpenAPI spec. Replaced with **client-side QC filtering** that
  accepts MADIS flags `V`, `C`, `S`, `Z` (per
  [MADIS QC notes](https://madis.ncep.noaa.gov/madis_sfc_qc_notes.shtml)).
- **Deleted dead state** (`lastTemperature`/`lastHumidity` fields that
  were written but never read).
- **Dropped per-instance/static metric duplication** — now a single
  per-platform metrics object, no leak across child-bridge restarts.
- **Removed undocumented `Referer` header** — NWS docs do not require it.

### NOAA / NWS correctness

- **NWS-recommended `User-Agent` format** — uses
  `(github.com/Phirtue/homebridge-weather-noaa, contact)` per the
  [API docs](https://www.weather.gov/documentation/services-web-api).
- **Rate-limit floor at 5s** — anchored to NWS docs guidance:
  *"may be retried after the limit clears (typically within 5 seconds)."*
- **`unitCode`-aware temperature conversion** — observations reported in
  `wmoUnit:degF` or `wmoUnit:K` are now correctly converted to °C
  instead of being trusted blindly as Celsius.
- **Humidity clamped to `[0, 100]`** before being pushed to HomeKit.
- **`config.schema.json` `refreshInterval` default** changed to `15` to
  match the runtime default.

### Reliability

- **No overlapping requests** — polling tick is mutex-guarded so a slow
  NOAA response cannot cause request pile-up.
- **Proper teardown** — `setTimeout`/`setInterval` handles tracked and
  cleared on Homebridge `shutdown` event; timers `unref`'d so they don't
  hold the event loop open.
- **`process.on('exit', ...)` listeners removed** — replaced with the
  Homebridge `shutdown` event so child-bridge restarts don't leak
  listeners.

### Template alignment

- **Source split into `settings.ts` / `index.ts` / `platform.ts` /
  `platformAccessory.ts`** matching the current Homebridge plugin
  template.
- **Accessories tracked in a `Map<string, PlatformAccessory>`** with O(1)
  UUID lookup, including stale-accessory cleanup.
- **`Logging` type used** instead of the deprecated `Logger` alias.
- **`AccessoryInformation` service populated** with manufacturer, model,
  serial, and firmware revision.
- **ESLint flat config** with `--max-warnings=0` enforced via
  `prepublishOnly`.
- **Two-arg `registerPlatform`** form per the current Homebridge API.

### Features

- **Adaptive polling** — when readings remain stable across consecutive
  polls, the interval automatically backs off up to 4× the base.
  Resets immediately on any change or error. Toggle via `adaptivePolling`
  config (default: on).

### Notes

- **Stable accessory UUID preserved** (`noaa-weather-unique`) so existing
  HomeKit room assignments and automations survive the upgrade.
- Existing station caches are honored if they validate against the new
  stricter schema; otherwise rebuilt automatically.
- Optional new config: `userAgentContact` (string) — adds your contact
  to the NOAA User-Agent header. Recommended by NWS.

---

## [1.5.0] - 2026-01-31

### Enhancements
- **Node.js 24 LTS support** — Officially tested and compatible with Node.js 24 (Krypton).
- **NOAA API alignment** — Uses the modern Points → Gridpoints → Stations flow (replaces deprecated `/points/{lat,lon}/stations`) and requests observations with `require_qc=true` for quality-controlled data.
- **429 Rate Limiting** — Added proper handling for NOAA API rate limiting with `Retry-After` header support.
- **Improved service management** — Use stable subtypes (`noaa-temperature`, `noaa-humidity`) with `getServiceById()` to prevent service collisions.
- **Safer config parsing** — Config values now properly coerced with `Number()` and validated with `Number.isFinite()` to handle string inputs from Homebridge UI.
- Updated dependencies:
  - `axios` to ^1.7.9
  - `typescript` to ^5.7.3
  - `@types/node` to ^22.10.7
- Ensures seamless operation on Homebridge installations running Node.js 18, 20, 22, or 24.

### Bug Fixes
- Fixed potential issue where latitude/longitude of `0` would be incorrectly treated as invalid.
- Improved TypeScript compatibility by using HAP characteristics via `this.platform.api.hap.Characteristic.*`.

### Notes
- No breaking changes from 1.4.0.
- Users on Node.js 24 will no longer see engine compatibility warnings during installation.
- Existing station caches will be rebuilt on first run to include new grid metadata.

---

## [1.4.0] - 2025-08-04

### Enhancements
- Added detailed metrics tracking:
  - API request failures
  - Retry attempts
  - Station cache resets
  - Cache write errors
  - Characteristic update errors
  - HomeKit service recovery attempts
- Implemented hourly and shutdown metrics logging for easier troubleshooting.
- All logs now display timestamps in the local timezone of the Homebridge device.
- Improved logging consistency across both platform and accessory code.
- Explicitly marked as **Homebridge v2 compatible**
- Added marketing tagline to highlight NOAA accuracy and v2 readiness.

### Bug Fixes
- Fixed potential stale data issues by ensuring forced updates to HomeKit.
- Improved automatic recovery from:
  - Corrupted cache files
  - Missing HomeKit services
- Prevents plugin from throwing unhandled exceptions that could crash Homebridge.

---

## [1.3.0] - 2025-08-03

### Enhancements
- Reuses cached accessories to avoid “Cached accessory found (not used)” messages.
- Ensures only one NOAA Weather accessory is created and reused after Homebridge restarts.
- Maintains persistent caching of station lookup and last NOAA readings.
- Forces HomeKit updates every fetch to keep displayed temperature and humidity synchronized.

### Bug Fixes
- Fixed duplicate accessory registration issues.
- Improved startup logs and accessory reuse behavior.

---

## [1.2.0] - 2025-08-03

### Enhancements
- HomeKit always shows a valid temperature and humidity reading, even right after restart.
- Persistent caching of last NOAA readings (`noaa-weather-last.json`).
- Real-time characteristic updates for temperature and humidity on each NOAA fetch.
- NOAA unchanged readings logged without skipping HomeKit updates.
- Graceful handling of NOAA null values.

### Bug Fixes
- Fixed brief zero or missing readings when NOAA API response delayed.
- Improved robustness of cache writes.

---

## [1.1.0] - 2025-08-03

### Enhancements
- Cached NOAA station lookups for 30 days.
- Added retry logic with exponential backoff for transient NOAA API errors.
- Updated headers to NOAA compliance (`Referer` and improved `User-Agent`).
- Manual station override supported.
- Metadata improvements for Homebridge verified plugin.
- Added CI tests for Node.js 18, 20, 22 with Homebridge v1 and v2 compatibility.

### Bug Fixes
- Fixed missing Node typings.
- Improved station selection and caching.
- Reused cached stations for efficiency.

---

## [1.0.0] - 2025-08-02

### Initial Release
- Basic Homebridge platform plugin providing temperature and humidity sensors via NOAA API.
- Supports automatic station detection and manual configuration.
- Fetches real-time NOAA observations and displays in HomeKit.
