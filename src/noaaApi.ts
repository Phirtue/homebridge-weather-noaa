import axios from 'axios';

export interface NOAAConfig {
  latitude: number;
  longitude: number;
}

export interface WeatherData {
  temperature: number;
  humidity: number;
}

export class NOAAApi {
  private stationUrl: string | null = null;

  constructor(private config: NOAAConfig) {}

  private async findNearestStation(): Promise<string> {
    if (this.stationUrl !== null) return this.stationUrl;

    const url = `https://api.weather.gov/points/${this.config.latitude},${this.config.longitude}`;
    const response = await axios.get(url);
    const stationsEndpoint = response.data.properties.observationStations;

    const stationsResp = await axios.get(stationsEndpoint);
    const id: string = stationsResp.data.features[0].id;

    this.stationUrl = id;
    return id;
  }

  async getCurrentWeather(): Promise<WeatherData> {
    const station = await this.findNearestStation();
    const obsResp = await axios.get(`${station}/observations/latest`);
    const obs = obsResp.data.properties;

    return {
      temperature: obs.temperature.value,
      humidity: obs.relativeHumidity.value
    };
  }
}