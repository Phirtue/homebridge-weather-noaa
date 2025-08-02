import { Service, PlatformAccessory } from 'homebridge';
import { NOAAWeatherPlatform } from './platform';

export class NOAAWeatherAccessory {
  private temperatureService: Service;
  private humidityService: Service;

  constructor(
    private readonly platform: NOAAWeatherPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const { Service, Characteristic } = this.platform.api.hap;

    this.temperatureService = 
      this.accessory.getService(Service.TemperatureSensor) ||
      this.accessory.addService(Service.TemperatureSensor, 'Temperature');

    this.temperatureService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({
        minValue: -100,
        maxValue: 150,
      });

    this.humidityService = 
      this.accessory.getService(Service.HumiditySensor) ||
      this.accessory.addService(Service.HumiditySensor, 'Humidity');

    this.updateValues();
  }

  updateValues() {
    const weather = this.accessory.context.weather;
    if (!weather) {
      this.platform.log.debug('No weather data available yet.');
      return;
    }

    // ✅ Use safe null checks
    const tempC = (weather.temperature !== null && weather.temperature !== undefined)
      ? weather.temperature
      : 0;

    const humidity = (weather.humidity !== null && weather.humidity !== undefined)
      ? weather.humidity
      : 0;

    this.platform.log.debug(`Updating Temp: ${tempC}°C, Humidity: ${humidity}%`);

    this.temperatureService.updateCharacteristic(
      this.platform.api.hap.Characteristic.CurrentTemperature,
      tempC
    );

    this.humidityService.updateCharacteristic(
      this.platform.api.hap.Characteristic.CurrentRelativeHumidity,
      humidity
    );
  }
}
