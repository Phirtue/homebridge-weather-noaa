# Changelog

All notable changes to **homebridge-weather-noaa** will be documented here.

---

## [1.2.0] - 2025-08-03

### Enhancements
- HomeKit now **always displays a valid temperature and humidity reading**, even immediately after Homebridge restarts.
- Implemented **persistent caching** of the last NOAA reading (`noaa-weather-last.json`) to prevent blank values on startup.
- Added **real-time characteristic updates** for temperature and humidity on every successful NOAA API fetch.
- NOAA responses with unchanged data now **log the event** without sending unnecessary updates to HomeKit.
- NOAA `null` values are handled gracefully, preserving the last known good reading.
- Improved overall stability and reliability of accessory updates while maintaining fresh, real-time readings.

### Bug Fixes
- Fixed cases where HomeKit could briefly display zero or missing values due to delayed NOAA responses.
- Made cache writes more robust, ensuring they do not fail silently.

---

## [1.1.0] - 2025-08-03

### Enhancements
- Added persistent caching of NOAA `/points` station lookups to reduce redundant API calls.
- Implemented exponential backoff retry logic for transient NOAA API errors (500/502/503/504).
- Improved NOAA API compliance:
  - Added `Referer` header
  - Updated `User-Agent` format to include GitHub repository URL.
- Allowed manual station ID override while keeping automatic nearest station selection.
- Updated package metadata with verified plugin fields (`homepage`, `bugs`, `engines`) for compatibility with Homebridge v1 and upcoming v2.
- Added GitHub Actions workflow to test Node.js 18, 20, and 22 with Homebridge v1 and v2 compatibility.

### Bug Fixes
- Fixed missing Node typings for `fs` and `path` during builds.
- Improved station selection with distance-based sorting and caching.
- Ensured cached station reuse to avoid unnecessary NOAA lookups.

---

## [1.0.0] - 2025-08-02

### Initial Release
- Basic Homebridge platform plugin providing temperature and humidity sensors using NOAA API.
- Supports automatic station detection and manual configuration.
- Fetches real-time data from NOAA and displays it in HomeKit.
