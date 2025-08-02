import { Service, PlatformAccessory } from 'homebridge';
import { NOAAWeatherPlatform } from './platform';

export class WeatherAccessory {
  private temperatureService: Service;
  private humidityService: Service;

  constructor(
    private readonly platform: NOAAWeatherPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.temperatureService = accessory.getService(this.platform.Service.TemperatureSensor)
      || accessory.addService(this.platform.Service.TemperatureSensor);
    this.humidityService = accessory.getService(this.platform.Service.HumiditySensor)
      || accessory.addService(this.platform.Service.HumiditySensor);

    this.temperatureService.setCharacteristic(this.platform.Characteristic.Name, 'Outdoor Temperature');
    this.humidityService.setCharacteristic(this.platform.Characteristic.Name, 'Outdoor Humidity');
  }

  updateData(weatherData) {
    this.temperatureService.updateCharacteristic(
      this.platform.Characteristic.CurrentTemperature,
      weatherData.temperature,
    );
    this.humidityService.updateCharacteristic(
      this.platform.Characteristic.CurrentRelativeHumidity,
      weatherData.humidity,
    );
  }
}