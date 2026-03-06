import { PlatformAccessory, Service, CharacteristicValue } from 'homebridge';
import { OmniLogicPlatform } from './platform';
import { MSPBodyOfWater } from './omnilogic/types';

export class OmniLogicTemperatureAccessory {
  private service: Service;
  private currentTempC = 0;

  constructor(
    private readonly platform: OmniLogicPlatform,
    public readonly accessory: PlatformAccessory,
  ) {
    const body: MSPBodyOfWater = accessory.context.body;

    // Accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Hayward')
      .setCharacteristic(this.platform.Characteristic.Model, 'OmniLogic Body of Water')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, String(body.systemId));

    // Temperature sensor service
    this.service =
      this.accessory.getService(this.platform.Service.TemperatureSensor) ||
      this.accessory.addService(this.platform.Service.TemperatureSensor, body.name);

    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this));
  }

  private getCurrentTemperature(): CharacteristicValue {
    return this.currentTempC;
  }

  /**
   * Called by the platform when telemetry polling updates water temperature.
   * Converts Fahrenheit to Celsius. Ignores -1 (no reading / pump off).
   */
  updateTemperature(tempF: number): void {
    if (tempF === -1) {
      return;
    }
    this.currentTempC = (tempF - 32) * 5 / 9;
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentTemperature,
      this.currentTempC,
    );
  }
}
