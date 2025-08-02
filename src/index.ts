import { API } from 'homebridge';
import { NOAAWeatherPlatform } from './platform';

export = (api: API) => {
  api.registerPlatform('NOAAWeather', NOAAWeatherPlatform);
};