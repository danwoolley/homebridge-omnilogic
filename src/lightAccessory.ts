import { PlatformAccessory, Service, CharacteristicValue } from 'homebridge';
import { OmniLogicPlatform } from './platform';
import { MSPLight } from './omnilogic/types';

export class OmniLogicLightAccessory {
  private service: Service;
  private isOn = false;

  constructor(
    private readonly platform: OmniLogicPlatform,
    public readonly accessory: PlatformAccessory,
  ) {
    const light: MSPLight = accessory.context.light;

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Hayward')
      .setCharacteristic(this.platform.Characteristic.Model, 'OmniLogic ColorLogic Light')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, `LIGHT-${light.systemId}`);

    this.service =
      this.accessory.getService(this.platform.Service.Lightbulb) ||
      this.accessory.addService(this.platform.Service.Lightbulb, light.name);

    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));
  }

  private getOn(): CharacteristicValue {
    return this.isOn;
  }

  private async setOn(value: CharacteristicValue): Promise<void> {
    const on = value as boolean;
    const light: MSPLight = this.accessory.context.light;

    this.platform.log.info(`Setting ${light.name} (${light.systemId}) to ${on ? 'ON' : 'OFF'}`);

    try {
      await this.platform.setLightState(light.bowSystemId, light.systemId, on);
      this.isOn = on;
    } catch (err) {
      this.platform.log.error(`Failed to set ${light.name}:`, (err as Error).message);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  /**
   * Called by the platform when telemetry polling updates light state.
   */
  updateState(on: boolean): void {
    this.isOn = on;
    this.service.updateCharacteristic(this.platform.Characteristic.On, on);
  }
}
