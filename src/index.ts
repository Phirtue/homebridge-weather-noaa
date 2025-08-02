import { API } from 'homebridge';
import { NOAAWeatherPlatform } from './platform';

export = (api: API) => {
  api.registerPlatform('homebridge-weather-noaa', 'NOAAWeatherPlatform', NOAAWeatherPlatform);
};
