# Homebridge NOAA Weather Plugin
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

Homebridge plugin providing temperature and humidity sensors using the [NOAA API](https://www.weather.gov/documentation/services-web-api).
Automatically detects the closest NOAA station or allows you to manually specify one.

## What’s New in v1.5.0

- Modern NOAA API flow: **Points → Gridpoints → Stations** (avoids deprecated endpoints)
- Requests **quality-controlled** observations (`require_qc=true`)
- Improved resilience to NOAA rate limiting (429 with `Retry-After`)
- Compatibility: Node.js **18 | 20 | 22 | 24** (no config changes required)

---

## Setup Instructions

### 1. No API Key Needed

This plugin uses NOAA's public API. It is **free** and requires **no registration**. USA weather reports only!

---

### 2. Install Plugin

```bash
sudo npm install -g homebridge-weather-noaa
```

---

### 3. Configure in Homebridge UI

- Go to **Plugins → Homebridge Weather NOAA → Settings**
- Enter:
  - Latitude / Longitude (decimal format)
  - Polling interval (minutes)
  - NOAA Station ID (optional, manually specified instead of auto detected)

---

### 4. Run Homebridge

Two accessories appear:
- `Outdoor Temperature`
- `Outdoor Humidity`

---

## Notes

- Data is fetched from the nearest NOAA observation station.
- Observations update every ~5–15 minutes.
- Adaptive polling reduces API calls if weather is stable.
- HomeKit uses Celsius internally but will automatically display Fahrenheit based on your iOS/HomeKit region.

---

## Build & Compatibility Status

[![CI Build](https://github.com/Phirtue/homebridge-weather-noaa/actions/workflows/ci.yml/badge.svg)](https://github.com/Phirtue/homebridge-weather-noaa/actions/workflows/ci.yml)

![Node.js](https://img.shields.io/badge/node-18%20|%2020%20|%2022-green)
![Homebridge](https://img.shields.io/badge/homebridge-v1%20|%20v2-blue)
[![npm version](https://img.shields.io/npm/v/homebridge-weather-noaa.svg)](https://www.npmjs.com/package/homebridge-weather-noaa)
