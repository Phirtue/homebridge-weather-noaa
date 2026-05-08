import { API } from 'homebridge';

import { NOAAWeatherPlatform } from './platform';
import { PLATFORM_NAME } from './settings';

export = (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, NOAAWeatherPlatform);
};
