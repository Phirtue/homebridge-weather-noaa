# Homebridge NOAA Weather Plugin

[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/plugins/wiki/Verified-Plugins)

[![CI Build](https://github.com/Phirtue/homebridge-weather-noaa/actions/workflows/ci.yml/badge.svg)](https://github.com/Phirtue/homebridge-weather-noaa/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Phirtue/homebridge-weather-noaa/actions/workflows/codeql.yml/badge.svg)](https://github.com/Phirtue/homebridge-weather-noaa/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Phirtue/homebridge-weather-noaa/badge)](https://scorecard.dev/viewer/?uri=github.com/Phirtue/homebridge-weather-noaa)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13651/badge)](https://www.bestpractices.dev/projects/13651)
[![npm version](https://img.shields.io/npm/v/homebridge-weather-noaa.svg)](https://www.npmjs.com/package/homebridge-weather-noaa)
![Node.js](https://img.shields.io/badge/node-20%20%7C%2022%20%7C%2024%20%7C%2026-green)
![Homebridge](https://img.shields.io/badge/homebridge-v1%20%7C%20v2-blue)

Temperature and humidity sensors for HomeKit, powered by the free
[NOAA / NWS API](https://www.weather.gov/documentation/services-web-api).
The plugin finds the observation station closest to your coordinates
automatically, or you can point it at a specific station.

## What's New in v1.10

- **Your location stays yours.** Coordinates are coarsened to about
  1 km before they are sent to NWS or written to disk, and they never
  appear in the Homebridge log, so pasting a log into a bug report no
  longer reveals where you live. Existing installs re-run station
  discovery once after upgrading.
- **Redirects are checked before they are followed.** No request
  header, including your optional contact address, can be sent to a
  host other than `api.weather.gov`.
- **Cache files must be small regular files**, written with exclusive
  create and read without following symlinks, closing off planted-file
  and oversized-file edge cases.
- **Node 18 support dropped** (end-of-life since April 2025). Node 20,
  22, 24 and 26 remain supported and CI-tested.
- **Supply chain tightened.** CI runs under a block-mode egress
  allowlist like the release pipeline, Dependabot waits 7 days before
  proposing new releases, and local installs never run dependency
  scripts.
- **Test suite.** 101 tests, including randomized property-based tests
  of the parsing and clamping logic, run in every CI matrix cell.

Earlier releases brought Node 26 and Homebridge 2.x support, verifiable
npm releases with provenance, SLSA provenance and a signed SBOM, a
hardened HTTP client, offline-boot recovery, stale-data detection, and
a formal [security policy](./SECURITY.md). See
[CHANGELOG.md](./CHANGELOG.md) for full details.

## Features

- **Zero runtime dependencies.** Built on native `fetch`; the published
  package contains only compiled plugin code.
- **Automatic station discovery** using the NOAA points and gridpoints
  APIs, cached for 30 days and retried with backoff when the network is
  down at boot.
- **Adaptive polling** that stretches the refresh interval up to 4x when
  readings are stable and snaps back on any change.
- **Persistent readings.** HomeKit shows the last known values
  immediately after a restart instead of blanks.
- **Quality-controlled data.** Readings that fail MADIS quality control
  are rejected, and temperatures reported in Fahrenheit or Kelvin are
  converted correctly.
- **Stale-data detection.** If the station stops reporting for 2 hours,
  the sensors are marked inactive in HomeKit so automations do not act
  on outdated readings.
- **Verifiable releases.** Published with npm provenance and a CycloneDX
  SBOM. See [Security](#security) below.

## Setup

### 1. No API key needed

The NOAA API is free and requires no registration. **USA weather only.**

### 2. Install

```bash
sudo npm install -g homebridge-weather-noaa
```

### 3. Configure

Use the settings UI under **Plugins, Homebridge Weather NOAA, Settings**,
or add the platform to `config.json` directly.

| Setting | Key | Required | Default | Description |
| ------- | --- | -------- | ------- | ----------- |
| Latitude | `latitude` | Yes | none | Decimal degrees, for example `47.6204` |
| Longitude | `longitude` | Yes | none | Decimal degrees, for example `-122.3494` |
| Refresh Interval | `refreshInterval` | No | `15` | Minutes between updates, minimum 5 |
| NOAA Station ID | `stationId` | No | auto | Overrides discovery, for example `KSEA` |
| Adaptive Polling | `adaptivePolling` | No | `true` | Slows polling while readings are stable |
| Contact (User-Agent) | `userAgentContact` | No | none | Email or URL added to the NOAA User-Agent header so NWS can reach you about API issues |

Example `config.json` entry:

```json
{
  "platform": "NOAAWeather",
  "name": "NOAA Weather",
  "latitude": 47.6204,
  "longitude": -122.3494,
  "refreshInterval": 15
}
```

The example coordinates are the Space Needle in Seattle, WA.

### 4. Run

Two accessories appear in HomeKit under "NOAA Weather":

- `NOAA Temperature`
- `NOAA Humidity`

## Notes

- Data comes from the NOAA observation station nearest your coordinates.
- Coordinates are rounded to 2 decimal places (roughly 1 km) before
  they are used. NWS resolves them to a 2.5 km grid cell, so this
  selects the same station in practice while keeping your exact
  address out of requests, cache files and logs. If you need a
  particular station, set `stationId`.
- Per the [NWS documentation](https://www.weather.gov/documentation/services-web-api),
  observations can lag up to 20 minutes due to quality-control
  processing, so refresh intervals shorter than 15 minutes provide
  diminishing value.
- HomeKit stores temperature in Celsius internally; iOS displays
  Fahrenheit automatically based on your region.
- Cache files live in the Homebridge persist path with owner-only
  permissions (`0o600`).
- Running the plugin as a
  [child bridge](https://github.com/homebridge/homebridge/wiki/Child-Bridges)
  is supported and recommended, as it is for any plugin: it isolates the
  plugin in its own process so an issue in one plugin cannot affect
  another.

## Security

This project aims to be a best-practice example of a secure Homebridge
plugin. Every release can be verified independently:

- **npm provenance.** Packages are published from GitHub Actions via
  [trusted publishing](https://docs.npmjs.com/trusted-publishers), with a
  Sigstore attestation linking the tarball to its source commit. Verify
  with `npm audit signatures`.
- **SBOM.** A CycloneDX software bill of materials is attached to every
  [GitHub release](https://github.com/Phirtue/homebridge-weather-noaa/releases).
- **Pipeline protections.** CodeQL analysis, dependency review, lockfile
  linting, SHA-pinned actions, and branch protection on every change.
- **OpenSSF Scorecard.** An independent, continuously updated audit of
  this repository's security posture, published as a public badge above.
- **OpenSSF Best Practices badge.** The project meets the
  [passing criteria](https://www.bestpractices.dev/projects/13651) of the
  OpenSSF Best Practices program for FLOSS development.
- **Signed releases.** The SBOM on each release carries a Sigstore
  signature, and new releases include SLSA build provenance generated by
  an isolated builder, so release artifacts are verifiable end to end.
- **Workflow analysis and egress control.** The CI/CD workflows
  themselves are statically analyzed by [zizmor](https://docs.zizmor.sh)
  on every change, both CI and the release pipeline run under a
  block-mode egress allowlist, and the published tarball's exact file
  list is asserted against a checked-in manifest before every publish.
- **Privacy by default.** No telemetry, no third-party services. The
  only outbound connection is to `api.weather.gov`, coordinates are
  coarsened to ~1 km before use, and they are never written to the log.

**Verify it yourself:** [VERIFYING.md](./VERIFYING.md) has the exact
`npm audit signatures`, `slsa-verifier`, and `cosign verify-blob`
commands, pinned to this repository's workflow identity.

Found a vulnerability? Please report it privately via the
[security policy](./SECURITY.md). Reports are acknowledged within 48
hours.

## Compatibility

| Requirement | Supported versions |
| ----------- | ------------------ |
| Node.js | 20, 22, 24, 26 |
| Homebridge | 1.8+, 2.x |

Every release is CI-tested across all twelve Node and Homebridge
combinations before it ships.

## License

[MIT](./LICENSE)
