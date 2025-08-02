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

    // Create Temperature Sensor service
    this.temperatureService = 
      this.accessory.getService(Service.TemperatureSensor) ||
      this.accessory.addService(Service.TemperatureSensor, 'Temperature');

    // Ensure minimum and maximum temperature characteristics are set
    this.temperatureService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({
        minValue: -100,
        maxValue: 150,
      });

    // Create Humidity Sensor service
    this.humidityService = 
      this.accessory.getService(Service.HumiditySensor) ||
      this.accessory.addService(Service.HumiditySensor, 'Humidity');

    // Initialize values
    this.updateValues();
  }

  /**
   * Update HomeKit characteristics from NOAA weather data
   */
  updateValues() {
    const weather = this.accessory.context.weather;
    if (!weather) {
      this.platform.log.debug('No weather data available yet.');
      return;
    }

    const temp = weather.temperature?.value ?? 0;
    const humidity = weather.relativeHumidity?.value ?? 0;

    this.platform.log.debug(`Updating Temperature: ${temp}°C, Humidity: ${humidity}%`);

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
