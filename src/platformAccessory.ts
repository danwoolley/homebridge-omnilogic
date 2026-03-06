import { PlatformAccessory, Service, CharacteristicValue } from 'homebridge';
import { OmniLogicPlatform } from './platform';
import { MSPGroup } from './omnilogic/types';

export class OmniLogicThemeAccessory {
  private service: Service;
  private isOn = false;

  constructor(
    private readonly platform: OmniLogicPlatform,
    public readonly accessory: PlatformAccessory,
  ) {
    const group: MSPGroup = accessory.context.group;

    // Accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Hayward')
      .setCharacteristic(this.platform.Characteristic.Model, 'OmniLogic Theme')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, String(group.systemId));

    // Switch service
    this.service =
      this.accessory.getService(this.platform.Service.Switch) ||
      this.accessory.addService(this.platform.Service.Switch, group.name);

    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));
  }

  /**
   * GET handler — returns cached state (kept fresh by polling).
   */
  private getOn(): CharacteristicValue {
    return this.isOn;
  }

  /**
   * SET handler — sends command to controller via UDP.
   */
  private async setOn(value: CharacteristicValue): Promise<void> {
    const on = value as boolean;
    const group: MSPGroup = this.accessory.context.group;

    this.platform.log.info(`Setting ${group.name} (${group.systemId}) to ${on ? 'ON' : 'OFF'}`);

    try {
      await this.platform.setGroupState(group.systemId, on);
      this.isOn = on;
    } catch (err) {
      this.platform.log.error(`Failed to set ${group.name}:`, (err as Error).message);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  /**
   * Called by the platform when telemetry polling updates group state.
   */
  updateState(on: boolean): void {
    this.isOn = on;
    this.service.updateCharacteristic(this.platform.Characteristic.On, on);
  }
}
