import { PlatformAccessory, Service, CharacteristicValue } from 'homebridge';
import { OmniLogicPlatform } from './platform';
import { MSPLight, TelemetryLight } from './omnilogic/types';
import { encodeShowData } from './omnilogic/xml';

// Map OmniLogic show number → HomeKit [hue, saturation].
// Multi-color shows remain unassigned.
const SHOW_TO_HUE_SAT: Record<number, [number, number]> = {
  // 0:  Voodoo Lounge   (not mapped)
  1:  [210, 100], // Deep Blue Sea
  2:  [240, 100], // Royal Blue
  3:  [200,  70], // Afternoon Sky
  4:  [175, 100], // Aqua Green
  5:  [140, 100], // Emerald
  6:  [  0,   0], // Cloud White
  7:  [  0, 100], // Warm Red
  8:  [340,  70], // Flamingo
  9:  [280, 100], // Vivid Violet
  10: [335, 100], // Sangria
  // 11: Twilight        (not mapped)
  // 12: Tranquility     (not mapped)
  // 13: Gemstone        (not mapped)
  // 14: USA             (not mapped)
  // 15: Mardi Gras      (not mapped)
  // 16: Cool Cabaret    (not mapped)
  17: [ 60, 100], // Yellow
  18: [ 25, 100], // Orange
  19: [ 45, 100], // Gold
  20: [145,  60], // Mint
  21: [180, 100], // Teal
  22: [ 18, 100], // Burnt Orange
  23: [  0,   0], // Pure White
  24: [200,  10], // Crisp White
  25: [ 30,  20], // Warm White
  26: [ 55, 100], // Bright Yellow
};

// Solid-color shows available for selection via the HomeKit color wheel.
// Multi-color shows (0, 11–16) are excluded — they can't be chosen by hue.
const SOLID_SHOWS: { show: number; hue: number }[] = [
  { show:  7, hue:   0 }, // Warm Red
  { show: 22, hue:  18 }, // Burnt Orange
  { show: 18, hue:  25 }, // Orange
  { show: 19, hue:  45 }, // Gold
  { show: 26, hue:  55 }, // Bright Yellow
  { show: 17, hue:  60 }, // Yellow
  { show:  5, hue: 140 }, // Emerald
  { show: 20, hue: 145 }, // Mint
  { show:  4, hue: 175 }, // Aqua Green
  { show: 21, hue: 180 }, // Teal
  { show:  3, hue: 200 }, // Afternoon Sky
  { show:  1, hue: 210 }, // Deep Blue Sea
  { show:  2, hue: 240 }, // Royal Blue
  { show:  9, hue: 280 }, // Vivid Violet
  { show: 10, hue: 335 }, // Sangria
  { show:  8, hue: 340 }, // Flamingo
];

function hueSatToShow(hue: number, saturation: number): number {
  if (saturation < 15) {
    return 6; // Cloud White for near-white/desaturated colors
  }
  let best = SOLID_SHOWS[0];
  let bestDist = Infinity;
  for (const s of SOLID_SHOWS) {
    const diff = Math.abs(s.hue - hue);
    const dist = Math.min(diff, 360 - diff); // circular distance
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }
  return best.show;
}

// OmniLogic brightness level 0–4 (= 20%, 40%, 60%, 80%, 100%) :: HomeKit 0–100%
function omniToHkBrightness(level: number): number {
  return (level + 1) * 20;
}

function hkToOmniBrightness(pct: number): number {
  return Math.max(0, Math.min(4, Math.ceil(pct / 20) - 1));
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

  private async setHue(value: CharacteristicValue): Promise<void> {
    const light: MSPLight = this.accessory.context.light;
    this.hue = value as number;
    this.currentShow = hueSatToShow(this.hue, this.saturation);
    this.platform.log.info(`Setting ${light.name} hue to ${this.hue}° → show ${this.currentShow}`);
    try {
      await this.sendShow();
    } catch (err) {
      this.platform.log.error(`Failed to set ${light.name} color:`, (err as Error).message);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  private async setSaturation(value: CharacteristicValue): Promise<void> {
    const light: MSPLight = this.accessory.context.light;
    this.saturation = value as number;
    this.currentShow = hueSatToShow(this.hue, this.saturation);
    this.platform.log.info(`Setting ${light.name} saturation to ${this.saturation}% → show ${this.currentShow}`);
    try {
      await this.sendShow();
    } catch (err) {
      this.platform.log.error(`Failed to set ${light.name} color:`, (err as Error).message);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  /**
   * Called by the platform on each telemetry poll to sync all light state.
   */
  updateState(ls: TelemetryLight): void {
    this.isOn = ls.lightState !== 0;
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
