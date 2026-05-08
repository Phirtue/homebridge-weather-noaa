# Homebridge NOAA Weather Plugin

[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

Homebridge plugin providing temperature and humidity sensors using the
[NOAA / NWS API](https://www.weather.gov/documentation/services-web-api).
Automatically detects the closest observation station for your coordinates,
or accepts a manual station ID.

## What's New in v1.6.0

A security- and minimalism-focused refresh. **No breaking config changes** —
existing v1.5 installs upgrade in place.

- **Zero runtime dependencies.** Native `fetch` replaces `axios`.
- **NWS-compliant `User-Agent`** in the documented
  `(github.com/Phirtue/homebridge-weather-noaa, contact)` format, with
  optional configurable contact field (sanitized against header injection).
- **Hardened input validation** on `stationId` (regex + `encodeURIComponent`),
  grid response shape, and coordinate bounds.
- **Atomic cache writes** with `0o600` permissions; bounded response size;
  `Retry-After` cap.
- **Client-side QC filtering** using documented MADIS flags (V/C/S/Z),
  replacing the unreliable `require_qc=true` server flag.
- **Unit-aware temperature conversion** — handles `°F` and `K` responses
  in addition to `°C`.
- **Adaptive polling** — backs off automatically (up to 4×) when readings
  are stable, recovers immediately on change. Toggleable.
- **Proper teardown** on Homebridge `shutdown`; per-instance metrics.
- **Template-aligned source layout** (`settings.ts` / `index.ts` /
  `platform.ts` / `platformAccessory.ts`) with `Logging` type and
  `accessories: Map`.

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
