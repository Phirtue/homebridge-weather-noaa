import { Service, PlatformAccessory } from 'homebridge';
import { NOAAWeatherPlatform } from './platform';

export class NOAAWeatherAccessory {
  private temperatureService: Service;
  private humidityService: Service;

  constructor(
    private readonly platform: NOAAWeatherPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const { Service } = this.platform.api.hap;
    this.temperatureService = this.accessory.addService(Service.TemperatureSensor, 'Temperature');
    this.humidityService = this.accessory.addService(Service.HumiditySensor, 'Humidity');
  }

  updateValues() {
    const weather = this.accessory.context.weather;
    if (!weather) return;

    const temp = weather.temperature.value;
    const humidity = weather.relativeHumidity.value;

    this.temperatureService.updateCharacteristic(
      this.platform.api.hap.Characteristic.CurrentTemperature,
      temp
    );
    this.humidityService.updateCharacteristic(
      this.platform.api.hap.Characteristic.CurrentRelativeHumidity,
      humidity
    );
  }
}
