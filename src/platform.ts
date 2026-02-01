import {
  API, Logger, PlatformAccessory, PlatformConfig, DynamicPlatformPlugin,
} from 'homebridge';
import axios, { AxiosInstance } from 'axios';
import fs from 'fs';
import path from 'path';
import { NOAAWeatherAccessory } from './weatherAccessory';

interface PointsCache {
  latitude: number;
  longitude: number;
  gridId: string;
  gridX: number;
  gridY: number;
  stationId: string;
  timestamp: number;
}

interface PointResponse {
  properties: {
    gridId: string;
    gridX: number;
    gridY: number;
  };
}

interface GridpointStationsResponse {
  features: Array<{
    properties: {
      stationIdentifier: string;
    };
  }>;
}

interface ObservationResponse {
  properties: {
    timestamp: string;
    temperature?: { value: number | null; qualityControl: string };
    relativeHumidity?: { value: number | null; qualityControl: string };
    elevation?: { value: number };
    presentWeather?: Array<{ weather: string }>;
  };
}

export class NOAAWeatherPlatform implements DynamicPlatformPlugin {
  private readonly axiosInstance: AxiosInstance;
  private readonly accessories: PlatformAccessory[] = [];

  private static metrics = {
    apiFailures: 0,
    retryCount: 0,
    rateLimitedCount: 0,
    stationCacheResets: 0,
  };

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.info(this.formatLog('NOAAWeatherPlatform initialized'));

    this.axiosInstance = axios.create({
      headers: {
        'User-Agent': 'homebridge-weather-noaa (https://github.com/Phirtue/homebridge-weather-noaa/)',
        'Accept': 'application/geo+json',
        'Referer': 'https://github.com/Phirtue/homebridge-weather-noaa',
      },
      timeout: 10000,
    });

    this.axiosInstance.interceptors.response.use(
      response => response,
      (error) => {
        NOAAWeatherPlatform.metrics.apiFailures++;
        const msg = (error && typeof error.message === 'string') ? error.message : String(error);
        this.log.error(this.formatLog(`NOAA API request failed: ${msg}`));
        return Promise.reject(error);
      },
    );

    api.on('didFinishLaunching', () => {
      this.safeDiscoverDevices().catch(err => {
        this.log.error(this.formatLog('Unhandled error in discoverDevices:'), err);
      });
    });

    setInterval(() => this.logMetrics(), 60 * 60 * 1000);
    process.on('exit', () => this.logMetrics());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info(this.formatLog('Re-using cached accessory:'), accessory.displayName);
    this.accessories.push(accessory);
  }

  /**
   * Safely parse a numeric config value, handling string inputs from Homebridge UI.
   */
  private getNumberConfig(key: string): number | undefined {
    const raw = (this.config as Record<string, unknown>)[key];
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }

  private async fetchWithRetry<T>(url: string, maxRetries = 4): Promise<T> {
    let attempt = 0;
    let delayMs = 1000;

    while (attempt < maxRetries) {
      try {
        const response = await this.axiosInstance.get<T>(url);
        return response.data;
      } catch (error: unknown) {
        const axiosError = error as {
          response?: {
            status: number;
            headers?: Record<string, string>;
          };
          message?: string;
        };
        const status: number = axiosError?.response?.status ?? 0;

        // Handle rate limiting (429) with Retry-After header support
        if (status === 429) {
          NOAAWeatherPlatform.metrics.rateLimitedCount++;
          const retryAfterRaw = axiosError?.response?.headers?.['retry-after'];
          const retryAfterSec = Number(retryAfterRaw);
          const waitMs = Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : delayMs;
          this.log.warn(this.formatLog(`Rate limited (429). Waiting ${waitMs / 1000}s before retry...`));
          await new Promise(res => setTimeout(res, waitMs));
          delayMs *= 2;
          attempt++;
          NOAAWeatherPlatform.metrics.retryCount++;
          continue;
        }

        // Handle server errors and no response
        if ([500, 502, 503, 504].includes(status) || status === 0) {
          NOAAWeatherPlatform.metrics.retryCount++;
          this.log.warn(this.formatLog(`Request failed (status: ${status || 'NO_RESPONSE'}). Retrying in ${delayMs / 1000}s...`));
          await new Promise(res => setTimeout(res, delayMs));
          delayMs *= 2;
          attempt++;
          continue;
        }

        throw error;
      }
    }
    throw new Error(`Failed after ${maxRetries} attempts for URL: ${url}`);
  }

  private async safeDiscoverDevices(): Promise<void> {
    try {
      await this.discoverDevices();
    } catch (err) {
      this.log.error(this.formatLog('Critical error during device discovery:'), err);
    }
  }

  private async discoverDevices(): Promise<void> {
    const latitude = this.getNumberConfig('latitude');
    const longitude = this.getNumberConfig('longitude');
    const refreshMinutes = this.getNumberConfig('refreshInterval') ?? 5;
    const refresh = refreshMinutes * 60 * 1000;
    const cacheFile = path.join(this.api.user.persistPath(), 'noaa-points-cache.json');

    // Validate coordinates (Note: 0 is valid for both lat/lon)
    if (latitude === undefined || longitude === undefined) {
      this.log.error(this.formatLog('Latitude and Longitude must be configured with valid numbers.'));
      return;
    }

    let stationId: string | null = (this.config.stationId as string) || null;

    if (!stationId && fs.existsSync(cacheFile)) {
      try {
        const cacheContent = fs.readFileSync(cacheFile, 'utf8');
        const cache: PointsCache = JSON.parse(cacheContent);
        const cacheAgeMs = Date.now() - cache.timestamp;
        const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

        if (
          cache.latitude === latitude &&
          cache.longitude === longitude &&
          cacheAgeMs < thirtyDaysMs &&
          typeof cache.stationId === 'string' &&
          cache.stationId.length > 0
        ) {
          const gridNote = (cache.gridId && Number.isFinite(cache.gridX) && Number.isFinite(cache.gridY))
            ? ` (grid ${cache.gridId}/${cache.gridX},${cache.gridY})`
            : '';
          this.log.info(this.formatLog(`📦 Using cached NOAA station: ${cache.stationId}${gridNote}`));
          stationId = cache.stationId;
        }
      } catch {
        NOAAWeatherPlatform.metrics.stationCacheResets++;
        this.log.warn(this.formatLog('Corrupted NOAA station cache detected. Rebuilding cache.'));
        try { fs.unlinkSync(cacheFile); } catch { /* ignore */ }
      }
    }

    if (!stationId && !this.config.stationId) {
      try {
        this.log.info(this.formatLog(`🔎 Fetching NOAA grid data for coordinates: ${latitude},${longitude}`));

        // Step 1: Get grid info from coordinates (modern NOAA API flow)
        const point = await this.fetchWithRetry<PointResponse>(
          `https://api.weather.gov/points/${latitude},${longitude}`
        );

        const { gridId, gridX, gridY } = point.properties;
        this.log.info(this.formatLog(`📍 Grid location: ${gridId}/${gridX},${gridY}`));

        // Step 2: Get stations for the grid cell (replaces deprecated /points/.../stations)
        const stations = await this.fetchWithRetry<GridpointStationsResponse>(
          `https://api.weather.gov/gridpoints/${gridId}/${gridX},${gridY}/stations`
        );

        const stationCandidates = stations.features
          .map(f => f.properties.stationIdentifier)
          .filter(id => /^[A-Z0-9]{3,4}$/.test(id));

        if (stationCandidates.length === 0) {
          this.log.error(this.formatLog('No valid NOAA stations found for grid cell.'));
          return;
        }

        // NOAA orders stations by representativeness; take the first
        stationId = stationCandidates[0];

        this.log.info(this.formatLog(
          `📡 NOAA grid station candidates (ordered): ${stationCandidates.slice(0, 10).join(', ')}`
        ));
        this.log.info(this.formatLog(`✅ Selected NOAA station: ${stationId} (grid ${gridId}/${gridX},${gridY})`));

        const cacheData: PointsCache = {
          latitude,
          longitude,
          gridId,
          gridX,
          gridY,
          stationId,
          timestamp: Date.now(),
        };
        fs.writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2));
      } catch (error) {
        this.log.error(this.formatLog('Failed to fetch NOAA stations'), error);
        return;
      }
    } else if (this.config.stationId) {
      this.log.info(this.formatLog(`📍 Using manually configured NOAA station: ${this.config.stationId}`));
      stationId = this.config.stationId as string;
    }

    const uuid = this.api.hap.uuid.generate('noaa-weather-unique');
    let accessory = this.accessories.find(acc => acc.UUID === uuid);

    if (accessory) {
      this.log.info(this.formatLog('Reusing existing accessory for NOAA Weather.'));
    } else {
      accessory = new this.api.platformAccessory('NOAA Weather', uuid);
      this.api.registerPlatformAccessories('homebridge-weather-noaa', 'NOAAWeather', [accessory]);
      this.log.info(this.formatLog('Created new accessory for NOAA Weather.'));
    }

    const weatherAccessory = new NOAAWeatherAccessory(this, accessory);

    const fetchWeather = async (): Promise<void> => {
      try {
        this.log.info(this.formatLog('🔄 Starting NOAA weather update...'));

        // Request observations with QC filtering
        const data = await this.fetchWithRetry<ObservationResponse>(
          `https://api.weather.gov/stations/${stationId}/observations/latest?require_qc=true`
        );

        const properties = data.properties;
        const timestamp = properties.timestamp;
        const temperature = properties.temperature?.value ?? null;
        const humidity = properties.relativeHumidity?.value ?? null;
        const tempQC = properties.temperature?.qualityControl ?? 'unknown';
        const humidityQC = properties.relativeHumidity?.qualityControl ?? 'unknown';
        const elevation = properties.elevation?.value ?? 0;
        const weatherConditions = properties.presentWeather?.map(w => w.weather).join(', ') || 'None';

        this.log.info(
          this.formatLog(
            `🌡️ NOAA Data — Timestamp: ${timestamp}, Temp: ${temperature}°C (QC: ${tempQC}), Humidity: ${humidity}% (QC: ${humidityQC}), Elevation: ${elevation}m, Conditions: ${weatherConditions}`
          )
        );

        accessory!.context.weather = { temperature, humidity };
        weatherAccessory.updateValues();
      } catch (e) {
        NOAAWeatherPlatform.metrics.apiFailures++;
        this.log.error(this.formatLog('❌ Failed to fetch NOAA data'), e);
      }
    };

    try {
      await fetchWeather();
    } catch (e) {
      this.log.error(this.formatLog('Initial NOAA fetch failed:'), e);
    }

    setInterval(() => {
      fetchWeather().catch(err => {
        NOAAWeatherPlatform.metrics.apiFailures++;
        this.log.error(this.formatLog('Recurring NOAA fetch failed:'), err);
      });
    }, refresh);
  }

  private logMetrics(): void {
    this.log.info(
      this.formatLog(
        `📊 NOAA Platform Metrics → API Failures: ${NOAAWeatherPlatform.metrics.apiFailures}, ` +
        `Retry Count: ${NOAAWeatherPlatform.metrics.retryCount}, ` +
        `Rate Limited: ${NOAAWeatherPlatform.metrics.rateLimitedCount}, ` +
        `Station Cache Resets: ${NOAAWeatherPlatform.metrics.stationCacheResets}`
      )
    );
  }

  private formatLog(message: string, data?: unknown): string {
    const now = new Date();
    const formattedTime = new Intl.DateTimeFormat('en-US', {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      hour12: true,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(now);

    return `[${formattedTime}] ${message}${data !== undefined ? ' ' + String(data) : ''}`;
  }
}
