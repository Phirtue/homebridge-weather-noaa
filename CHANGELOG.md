# Changelog

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
