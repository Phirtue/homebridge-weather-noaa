# Homebridge NOAA Weather Plugin

Homebridge plugin providing temperature and humidity sensors using the [NOAA API](https://www.weather.gov/documentation/services-web-api).
Automatically detects the closest NOAA station or allows you to manually specify one.

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

- Go to **Plugins → NOAA Weather → Settings**
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
- HomeKit uses Celsius internally but will automatically display Fahrenheit based on your region.

---

## Build & Compatibility Status

[![CI Build](https://github.com/Phirtue/homebridge-weather-noaa/actions/workflows/ci.yml/badge.svg)](https://github.com/Phirtue/homebridge-weather-noaa/actions/workflows/ci.yml)

![Node.js](https://img.shields.io/badge/node-18%20|%2020%20|%2022-green)
![Homebridge](https://img.shields.io/badge/homebridge-v1%20|%20v2-blue)
[![npm version](https://img.shields.io/npm/v/homebridge-weather-noaa.svg)](https://www.npmjs.com/package/homebridge-weather-noaa)
