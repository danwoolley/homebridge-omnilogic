import { PlatformAccessory, Service, CharacteristicValue } from 'homebridge';
import { OmniLogicPlatform } from './platform';
import { MSPLight, TelemetryLight } from './omnilogic/types';
import { encodeShowData } from './omnilogic/xml';

export const SHOW_DATA: Record<number, { name: string; hueSat?: [number, number] }> = {
  0: { name: 'Voodoo Lounge' },
  1: { name: 'Deep Blue Sea', hueSat: [222, 65] },
  2: { name: 'Royal Blue', hueSat: [203, 99] },
  3: { name: 'Afternoon Sky', hueSat: [197, 100] },
  4: { name: 'Aqua Green', hueSat: [177, 99] },
  5: { name: 'Emerald', hueSat: [147, 100] },
  6: { name: 'Cloud White', hueSat: [180, 13] },
  7: { name: 'Warm Red', hueSat: [14, 85] },
  8: { name: 'Flamingo', hueSat: [340, 92] },
  9: { name: 'Vivid Violet', hueSat: [325, 100] },
  10: { name: 'Sangria', hueSat: [319, 72] },
  11: { name: 'Twilight' },
  12: { name: 'Tranquility' },
  13: { name: 'Gemstone' },
  14: { name: 'USA' },
  15: { name: 'Mardi Gras' },
  16: { name: 'Cool Cabaret' },
  17: { name: 'Yellow', hueSat: [60, 60] },
  18: { name: 'Orange', hueSat: [39, 100] },
  19: { name: 'Gold', hueSat: [51, 100] },
  20: { name: 'Mint', hueSat: [120, 40] },
  21: { name: 'Teal', hueSat: [180, 100] },
  22: { name: 'Burnt Orange', hueSat: [24, 100] },
  23: { name: 'Pure White', hueSat: [0, 0] },
  24: { name: 'Crisp White', hueSat: [324, 4] },
  25: { name: 'Warm White', hueSat: [34, 12] },
  26: { name: 'Bright Yellow', hueSat: [60, 100] },
};

function hueSatToShow(hue: number, saturation: number): number {
  let bestShow = 6; // default to Cloud White
  let bestDist = Infinity;
  for (const [showStr, data] of Object.entries(SHOW_DATA)) {
    if (!data.hueSat) continue;
    const show = parseInt(showStr);
    const [h, s] = data.hueSat;
    const hueDiff = Math.min(Math.abs(hue - h), 360 - Math.abs(hue - h));  // Account for hue wraparound
    const satDiff = Math.abs(saturation - s);
    const dist = Math.sqrt(hueDiff ** 2 + satDiff ** 2);   // Pythagorean distance in hue-sat space
    if (dist < bestDist) {
      bestDist = dist;
      bestShow = show;
    }
  }
  return bestShow;
}

function omniToHkBrightness(level: number): number {
  // OmniLogic brightness level 0–4 (= 20%, 40%, 60%, 80%, 100%) :: HomeKit 0–100%
  return (level + 1) * 20;
}

function hkToOmniBrightness(pct: number): number {
  return Math.max(0, Math.min(4, Math.ceil(pct / 20) - 1));
}

function isLightOn(lightState: number): boolean {
  // Map OmniLogic light states to on/off:
  // OFF: 0 (off), 1 (powering off stage 1), 7 (powering off stage 2)
  // ON: 3 (transitioning), 4 (15 sec white light), 6 (on)
  return [3, 4, 6].includes(lightState);
}

export class OmniLogicLightAccessory {
  private service: Service;

  // HomeKit-facing cached values
  private isOn = false;
  private hue = 0;
  private saturation = 0;
  private brightness = 100;

  // OmniLogic-facing cached values (kept in sync with telemetry)
  private currentShow = 1;
  private currentSpeed = 4;
  private currentBrightnessLevel = 4;

  // Debounce color updates
  private colorUpdateTimeout: NodeJS.Timeout | null = null;

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
      .onGet(() => this.isOn)
      .onSet(this.setOn.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.Brightness)
      .onGet(() => this.brightness)
      .onSet(this.setBrightness.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.Hue)
      .onGet(() => this.hue)
      .onSet(this.setHue.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.Saturation)
      .onGet(() => this.saturation)
      .onSet(this.setSaturation.bind(this));
  }

  // data=0 means "resume last active show" — used for simple on/off toggles.
  // Pass encodeShowData(...) when explicitly changing show, speed, or brightness.
  private async sendCommand(on: boolean, data = 0): Promise<void> {
    const light: MSPLight = this.accessory.context.light;
    await this.platform.setLightState(light.bowSystemId, light.systemId, on, data);
  }

  private async setOn(value: CharacteristicValue): Promise<void> {
    const on = value as boolean;
    const light: MSPLight = this.accessory.context.light;
    this.platform.log.info(`Setting ${light.name} to ${on ? 'ON' : 'OFF'}`);
    try {
      this.isOn = on;
      await this.sendCommand(on); // Data=0: resume last active show
    } catch (err) {
      this.platform.log.error(`Failed to set ${light.name}:`, (err as Error).message);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  private async sendShow(): Promise<void> {
    const light: MSPLight = this.accessory.context.light;
    await this.platform.setLightShow(
      light.bowSystemId,
      light.systemId,
      encodeShowData(this.currentShow, this.currentSpeed, this.currentBrightnessLevel),
    );
  }

  private async setBrightness(value: CharacteristicValue): Promise<void> {
    const pct = value as number;
    const light: MSPLight = this.accessory.context.light;
    this.brightness = pct;
    this.currentBrightnessLevel = hkToOmniBrightness(pct);
    this.platform.log.info(`Setting ${light.name} brightness to ${pct}% (level ${this.currentBrightnessLevel})`);
    try {
      await this.sendShow();
    } catch (err) {
      this.platform.log.error(`Failed to set ${light.name} brightness:`, (err as Error).message);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  private async setColor(hue: number, saturation: number): Promise<void> {
    const light: MSPLight = this.accessory.context.light;
    this.hue = hue;
    this.saturation = saturation;
    this.currentShow = hueSatToShow(this.hue, this.saturation);
    this.platform.log.info(`Setting ${light.name} color to ${SHOW_DATA[this.currentShow]?.name ?? `show ${this.currentShow}`}`);
    try {
      await this.sendShow();
    } catch (err) {
      this.platform.log.error(`Failed to set ${light.name} color show:`, (err as Error).message);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  private scheduleColorUpdate(): void {
    if (this.colorUpdateTimeout) {
      clearTimeout(this.colorUpdateTimeout);
    }
    this.colorUpdateTimeout = setTimeout(() => {
      this.colorUpdateTimeout = null;
      this.setColor(this.hue, this.saturation);
    }, 100); // 100ms debounce delay
  }

  private async setHue(value: CharacteristicValue): Promise<void> {
    this.hue = value as number;
    this.scheduleColorUpdate();
  }

  private async setSaturation(value: CharacteristicValue): Promise<void> {
    this.saturation = value as number;
    this.scheduleColorUpdate();
  }

  /**
   * Called by the platform on each telemetry poll to sync all light state.
   */
  updateState(ls: TelemetryLight): void {
    this.isOn = isLightOn(ls.lightState);
    this.currentShow = ls.currentShow;
    this.currentSpeed = ls.speed;
    this.currentBrightnessLevel = ls.brightness;
    this.brightness = omniToHkBrightness(ls.brightness);
    [this.hue, this.saturation] = SHOW_DATA[ls.currentShow]?.hueSat ?? [0, 0];

    this.service.updateCharacteristic(this.platform.Characteristic.On, this.isOn);
    this.service.updateCharacteristic(this.platform.Characteristic.Brightness, this.brightness);
    this.service.updateCharacteristic(this.platform.Characteristic.Hue, this.hue);
    this.service.updateCharacteristic(this.platform.Characteristic.Saturation, this.saturation);
  }
}
