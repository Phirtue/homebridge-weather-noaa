# Homebridge NOAA Weather Plugin

[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

Homebridge plugin providing temperature and humidity sensors using the
[NOAA / NWS API](https://www.weather.gov/documentation/services-web-api).
Automatically detects the closest observation station for your coordinates,
or accepts a manual station ID.

## What's New in v1.7.0

A security-focused release from a full code review against the
[Homebridge plugin template](https://github.com/homebridge/homebridge-plugin-template)
and the [NWS OpenAPI spec](https://api.weather.gov/openapi.json).
**No breaking config changes** — existing installs upgrade in place.

- **Homebridge 2.x ready** — the plugin is now an ES module, verified on
  Homebridge 1.11 and 2.1.
- **Verifiable releases** — published to npm from GitHub Actions via
  [trusted publishing](https://docs.npmjs.com/trusted-publishers) with a
  provenance attestation; no npm token exists anywhere. A CycloneDX SBOM
  is attached to every GitHub release.
- **Hardened HTTP client** — the 2 MB response cap is enforced while the
  body streams (oversized payloads are aborted, not buffered), and
  redirects must stay on the `api.weather.gov` origin.
- **Temperature clamping** — live and cached readings are clamped to
  HomeKit's valid range, so a corrupt cache file can never push
  out-of-range values.
- **NWS spec alignment** — coordinates rounded to 4 decimals before the
  `/points` call (avoids a 301 redirect), `Accept: application/geo+json`
  only, and MADIS QC flag `G` (subjective good) now accepted.
- **Hardened CI/CD** — CodeQL static analysis, dependency review on PRs,
  lockfile linting, `--ignore-scripts` installs, SHA-pinned actions,
  least-privilege tokens, and Dependabot updates.
- **Cleaner internals** — HTTP retry/backoff and station-cache I/O split
  into dedicated modules, one typed config parser, version read from
  `package.json`, quieter routine logs.

Still true from v1.6: zero runtime dependencies, NWS-compliant
`User-Agent`, validated inputs, atomic `0o600` cache writes, adaptive
polling, and unit-aware temperature conversion.

See [CHANGELOG.md](./CHANGELOG.md) for the full list.

---

## Setup

### 1. No API Key Needed

NOAA's public API is free and requires no registration. **USA weather only.**

### 2. Install

```bash
sudo npm install -g homebridge-weather-noaa
```

### 3. Configure in Homebridge UI

Go to **Plugins → Homebridge Weather NOAA → Settings** and enter:

- **Latitude / Longitude** (decimal format, e.g. `47.6062`, `-122.3321`)
- **Refresh Interval** in minutes (default 15, minimum 5)
- **NOAA Station ID** (optional, e.g. `KSEA` — overrides auto-discovery)
- **Adaptive Polling** (default on — slows polling when readings are stable)
- **Contact (User-Agent)** (optional — email or URL added to the NOAA
  `User-Agent` header so NWS can reach you about API issues; recommended
  by NWS)

### 4. Run Homebridge

Two HomeKit accessories appear under "NOAA Weather":

- `NOAA Temperature`
- `NOAA Humidity`

---

## Notes

- Data comes from the NOAA observation station nearest your coordinates.
- Per the [NWS docs](https://www.weather.gov/documentation/services-web-api),
  observations may be delayed up to 20 minutes from MADIS due to QC
  processing — refresh intervals shorter than 15 minutes provide
  diminishing value.
- Adaptive polling stretches the interval up to 4× when readings are
  unchanged across consecutive polls.
- HomeKit stores temperature in Celsius internally; iOS/HomeKit displays
  Fahrenheit automatically based on your region.
- Cache files are stored in your Homebridge persist path with mode `0o600`.

---

## Build & Compatibility

[![CI Build](https://github.com/Phirtue/homebridge-weather-noaa/actions/workflows/ci.yml/badge.svg)](https://github.com/Phirtue/homebridge-weather-noaa/actions/workflows/ci.yml)
![Node.js](https://img.shields.io/badge/node-18%20%7C%2020%20%7C%2022%20%7C%2024-green)
![Homebridge](https://img.shields.io/badge/homebridge-v1%20%7C%20v2-blue)
[![npm version](https://img.shields.io/npm/v/homebridge-weather-noaa.svg)](https://www.npmjs.com/package/homebridge-weather-noaa)
