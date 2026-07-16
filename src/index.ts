import type { API } from 'homebridge';

import { NOAAWeatherPlatform } from './platform.js';
import { PLATFORM_NAME } from './settings.js';

export default (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, NOAAWeatherPlatform);
};
