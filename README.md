# Homebridge NOAA Weather Plugin

Fetches **temperature** and **humidity** from NOAA's National Weather Service API and exposes them to HomeKit as sensors.

---

## Setup Instructions

### 1. No API Key Needed

This plugin uses NOAA's public API. It is **free** and requires **no registration**. It can only report weather in the USA.

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

---

### 4. Run Homebridge

Two accessories appear:
- `Outdoor Temperature`
- `Outdoor Humidity`

---

## Notes

- Data is fetched from the nearest NOAA observation station.
- Observations update every ~10–15 minutes.
- Adaptive polling reduces API calls if weather is stable.
- HomeKit uses Celsius internally but will automatically display Fahrenheit based on your region.

---
