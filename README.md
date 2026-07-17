# Homebridge NOAA Weather Plugin

[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

[![CI Build](https://github.com/Phirtue/homebridge-weather-noaa/actions/workflows/ci.yml/badge.svg)](https://github.com/Phirtue/homebridge-weather-noaa/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Phirtue/homebridge-weather-noaa/actions/workflows/codeql.yml/badge.svg)](https://github.com/Phirtue/homebridge-weather-noaa/actions/workflows/codeql.yml)
[![npm version](https://img.shields.io/npm/v/homebridge-weather-noaa.svg)](https://www.npmjs.com/package/homebridge-weather-noaa)
![Node.js](https://img.shields.io/badge/node-18%20%7C%2020%20%7C%2022%20%7C%2024%20%7C%2026-green)
![Homebridge](https://img.shields.io/badge/homebridge-v1%20%7C%20v2-blue)

Temperature and humidity sensors for HomeKit, powered by the free
[NOAA / NWS API](https://www.weather.gov/documentation/services-web-api).
The plugin finds the observation station closest to your coordinates
automatically, or you can point it at a specific station.

## What's New in v1.9.0

- **Survives offline starts.** If the network is not up when Homebridge
  boots, station discovery now retries automatically with a doubling
  backoff instead of staying inactive until a manual restart.
- **Hardened further.** The redirect origin check now runs before any
  response handling, and the npm CLI used by the release pipeline is
  version-pinned like everything else in it.

Recent releases brought Node 26 and Homebridge 2.x support, verifiable
npm releases with provenance and SBOM, a hardened HTTP client, and a
formal [security policy](./SECURITY.md). See
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
| Latitude | `latitude` | Yes | none | Decimal degrees, for example `47.6062` |
| Longitude | `longitude` | Yes | none | Decimal degrees, for example `-122.3321` |
| Refresh Interval | `refreshInterval` | No | `15` | Minutes between updates, minimum 5 |
| NOAA Station ID | `stationId` | No | auto | Overrides discovery, for example `KSEA` |
| Adaptive Polling | `adaptivePolling` | No | `true` | Slows polling while readings are stable |
| Contact (User-Agent) | `userAgentContact` | No | none | Email or URL added to the NOAA User-Agent header so NWS can reach you about API issues |

Example `config.json` entry:

```json
{
  "platform": "NOAAWeather",
  "name": "NOAA Weather",
  "latitude": 47.6062,
  "longitude": -122.3321,
  "refreshInterval": 15
}
```

### 4. Run

Two accessories appear in HomeKit under "NOAA Weather":

- `NOAA Temperature`
- `NOAA Humidity`

## Notes

- Data comes from the NOAA observation station nearest your coordinates.
- Per the [NWS documentation](https://www.weather.gov/documentation/services-web-api),
  observations can lag up to 20 minutes due to quality-control
  processing, so refresh intervals shorter than 15 minutes provide
  diminishing value.
- HomeKit stores temperature in Celsius internally; iOS displays
  Fahrenheit automatically based on your region.
- Cache files live in the Homebridge persist path with owner-only
  permissions (`0o600`).

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

Found a vulnerability? Please report it privately via the
[security policy](./SECURITY.md). Reports are acknowledged within 48
hours.

## Compatibility

| Requirement | Supported versions |
| ----------- | ------------------ |
| Node.js | 18, 20, 22, 24, 26 |
| Homebridge | 1.8+, 2.x |

Every release is CI-tested across all fifteen Node and Homebridge
combinations before it ships.

## License

[MIT](./LICENSE)
