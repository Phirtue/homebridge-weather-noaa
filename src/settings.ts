import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

/** Platform name users register in Homebridge config.json. */
export const PLATFORM_NAME = 'NOAAWeather';

/** Must match the package.json `name`. */
export const PLUGIN_NAME = 'homebridge-weather-noaa';

/**
 * Read the version from package.json (one level above dist/ at runtime) so
 * it can never drift from the published release.
 */
export const PLUGIN_VERSION: string = (
  JSON.parse(
    fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
      'utf8',
    ),
  ) as { version: string }
).version;
