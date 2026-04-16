import { PlatformAccessory, Service, CharacteristicValue } from 'homebridge';
import { OmniLogicPlatform } from './platform';
import { MSPLight, TelemetryLight } from './omnilogic/types';
import { encodeShowData } from './omnilogic/xml';

// Map OmniLogic show number → HomeKit [hue, saturation].
// Values are RGB->HSV conversion of swatches from: https://haywardomnilogic.com/Module/UserManagement/LightShow.aspx
// Multi-color shows remain unassigned.
const SHOW_TO_HUE_SAT: Record<number, [number, number]> = {
  // 0:  Voodoo Lounge   (not mapped)
  1:  [222,  65], // Deep Blue Sea
  2:  [203,  99], // Royal Blue
  3:  [197, 100], // Afternoon Sky
  4:  [177,  99], // Aqua Green
  5:  [147, 100], // Emerald
  6:  [180,  13], // Cloud White
  7:  [ 14,  85], // Warm Red
  8:  [340,  92], // Flamingo
  9:  [325, 100], // Vivid Violet
  10: [319,  72], // Sangria
  // 11: Twilight        (not mapped)
  // 12: Tranquility     (not mapped)
  // 13: Gemstone        (not mapped)
  // 14: USA             (not mapped)
  // 15: Mardi Gras      (not mapped)
  // 16: Cool Cabaret    (not mapped)
  17: [ 60,  60], // Yellow
  18: [ 39, 100], // Orange
  19: [ 51, 100], // Gold
  20: [120,  40], // Mint
  21: [180, 100], // Teal
  22: [ 24, 100], // Burnt Orange
  23: [  0,   0], // Pure White
  24: [324,   4], // Crisp White
  25: [ 34,  12], // Warm White
  26: [ 60, 100], // Bright Yellow
};

function hueSatToShow(hue: number, saturation: number): number {
  let bestShow = 6; // default to Cloud White
  let bestDist = Infinity;
  for (const [showStr, [h, s]] of Object.entries(SHOW_TO_HUE_SAT)) {
    const show = parseInt(showStr);
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
    this.platform.log.info(`Setting ${light.name} color show ${this.currentShow} (Hue:${this.hue} Sat:${this.saturation}%)`);
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
    [this.hue, this.saturation] = SHOW_TO_HUE_SAT[ls.currentShow] ?? [0, 0];

    this.service.updateCharacteristic(this.platform.Characteristic.On, this.isOn);
    this.service.updateCharacteristic(this.platform.Characteristic.Brightness, this.brightness);
    this.service.updateCharacteristic(this.platform.Characteristic.Hue, this.hue);
    this.service.updateCharacteristic(this.platform.Characteristic.Saturation, this.saturation);
  }
}
