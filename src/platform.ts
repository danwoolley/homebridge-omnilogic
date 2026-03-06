import {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { OmniLogicClient } from './omnilogic/client';
import { GroupState, MSPGroup, MSPBodyOfWater } from './omnilogic/types';
import { parseGroups, parseBodiesOfWater, parseGroupTelemetry, parseBodyOfWaterTelemetry } from './omnilogic/xml';
import { OmniLogicThemeAccessory } from './platformAccessory';
import { OmniLogicTemperatureAccessory } from './temperatureAccessory';

interface OmniLogicConfig extends PlatformConfig {
  host: string;
  pollingInterval?: number;
}

export class OmniLogicPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly accessories: Map<string, PlatformAccessory> = new Map();
  private readonly themeAccessories: Map<string, OmniLogicThemeAccessory> = new Map();
  private readonly tempAccessories: Map<string, OmniLogicTemperatureAccessory> = new Map();
  private client: OmniLogicClient | null = null;
  private pollingTimer: ReturnType<typeof setInterval> | undefined;
  private readonly config: OmniLogicConfig;

  constructor(
    public readonly log: Logging,
    config: PlatformConfig,
    public readonly api: API,
  ) {
    this.config = config as OmniLogicConfig;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    if (!this.config.host) {
      this.log.error('No host configured — plugin will not start');
      return;
    }

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();
    });

    this.api.on('shutdown', () => {
      if (this.pollingTimer) {
        clearInterval(this.pollingTimer);
      }
      this.client?.close();
    });
  }

  /**
   * Called by Homebridge to restore cached accessories from disk.
   */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Restoring cached accessory:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  private async discoverDevices(): Promise<void> {
    this.client = new OmniLogicClient(this.config.host);

    let configXml: string;
    try {
      configXml = await this.client.getConfig();
    } catch (err) {
      this.log.error('Failed to connect to OmniLogic controller:', (err as Error).message);
      this.log.error('Will retry on next polling cycle');
      this.startPolling();
      return;
    }

    const groups = parseGroups(configXml);
    const bodies = parseBodiesOfWater(configXml);
    this.log.info(`Discovered ${groups.length} theme(s) and ${bodies.length} body/bodies of water`);

    const discoveredUUIDs = new Set<string>();

    // Register switch accessories for each group
    for (const group of groups) {
      const uuid = this.api.hap.uuid.generate(`omnilogic-group-${group.systemId}`);
      discoveredUUIDs.add(uuid);

      let accessory = this.accessories.get(uuid);

      if (accessory) {
        this.log.info('Updating existing accessory:', group.name);
        accessory.context.group = group;
        this.api.updatePlatformAccessories([accessory]);
      } else {
        this.log.info('Adding new accessory:', group.name);
        accessory = new this.api.platformAccessory(group.name, uuid);
        accessory.context.group = group;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
      }

      const themeAccessory = new OmniLogicThemeAccessory(this, accessory);
      this.themeAccessories.set(uuid, themeAccessory);
    }

    // Register temperature sensor accessories for each body of water
    for (const body of bodies) {
      const uuid = this.api.hap.uuid.generate(`omnilogic-bow-${body.systemId}`);
      discoveredUUIDs.add(uuid);

      let accessory = this.accessories.get(uuid);

      if (accessory) {
        this.log.info('Updating existing accessory:', body.name);
        accessory.context.body = body;
        this.api.updatePlatformAccessories([accessory]);
      } else {
        this.log.info('Adding new temperature sensor:', body.name);
        accessory = new this.api.platformAccessory(body.name, uuid);
        accessory.context.body = body;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
      }

      const tempAccessory = new OmniLogicTemperatureAccessory(this, accessory);
      this.tempAccessories.set(uuid, tempAccessory);
    }

    // Remove stale accessories no longer on the controller
    for (const [uuid, accessory] of this.accessories) {
      if (!discoveredUUIDs.has(uuid)) {
        this.log.info('Removing stale accessory:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
        this.themeAccessories.delete(uuid);
        this.tempAccessories.delete(uuid);
      }
    }

    // Initial telemetry fetch, then start polling
    await this.pollTelemetry();
    this.startPolling();
  }

  private startPolling(): void {
    const interval = (this.config.pollingInterval ?? 30) * 1000;
    this.pollingTimer = setInterval(() => {
      this.pollTelemetry();
    }, interval);
  }

  private async pollTelemetry(): Promise<void> {
    if (!this.client) {
      return;
    }

    let telemetryXml: string;
    try {
      telemetryXml = await this.client.getTelemetry();
    } catch (err) {
      this.log.warn('Failed to poll telemetry:', (err as Error).message);
      return;
    }

    // Update group states
    const states = parseGroupTelemetry(telemetryXml);
    const stateMap = new Map<number, GroupState>();
    for (const s of states) {
      stateMap.set(s.systemId, s.state);
    }

    for (const themeAccessory of this.themeAccessories.values()) {
      const group: MSPGroup = themeAccessory.accessory.context.group;
      const state = stateMap.get(group.systemId);
      if (state !== undefined) {
        themeAccessory.updateState(state === GroupState.ON);
      }
    }

    // Update body of water temperatures
    const bodyTemps = parseBodyOfWaterTelemetry(telemetryXml);
    const tempMap = new Map<number, number>();
    for (const b of bodyTemps) {
      tempMap.set(b.systemId, b.waterTemp);
    }

    for (const tempAccessory of this.tempAccessories.values()) {
      const body: MSPBodyOfWater = tempAccessory.accessory.context.body;
      const temp = tempMap.get(body.systemId);
      if (temp !== undefined) {
        tempAccessory.updateTemperature(temp);
      }
    }
  }

  /**
   * Called by accessories to send a command to the controller.
   */
  async setGroupState(groupId: number, on: boolean): Promise<void> {
    if (!this.client) {
      throw new Error('OmniLogic client not initialized');
    }
    await this.client.setGroupState(groupId, on);
  }
}
