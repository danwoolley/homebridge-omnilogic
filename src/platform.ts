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
import { GroupState, MSPGroup, TelemetryGroup } from './omnilogic/types';
import { OmniLogicThemeAccessory } from './platformAccessory';

interface OmniLogicConfig extends PlatformConfig {
  host: string;
  pollingInterval?: number;
}

export class OmniLogicPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly accessories: Map<string, PlatformAccessory> = new Map();
  private readonly themeAccessories: Map<string, OmniLogicThemeAccessory> = new Map();
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

    let groups: MSPGroup[];
    try {
      groups = await this.client.getGroups();
      this.log.info(`Discovered ${groups.length} theme(s) from OmniLogic controller`);
    } catch (err) {
      this.log.error('Failed to connect to OmniLogic controller:', (err as Error).message);
      this.log.error('Will retry on next polling cycle');
      this.startPolling();
      return;
    }

    // Register accessories for each group
    const discoveredUUIDs = new Set<string>();

    for (const group of groups) {
      const uuid = this.api.hap.uuid.generate(`omnilogic-group-${group.systemId}`);
      discoveredUUIDs.add(uuid);

      let accessory = this.accessories.get(uuid);

      if (accessory) {
        // Update existing accessory
        this.log.info('Updating existing accessory:', group.name);
        accessory.context.group = group;
        this.api.updatePlatformAccessories([accessory]);
      } else {
        // Create new accessory
        this.log.info('Adding new accessory:', group.name);
        accessory = new this.api.platformAccessory(group.name, uuid);
        accessory.context.group = group;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
      }

      const themeAccessory = new OmniLogicThemeAccessory(this, accessory);
      this.themeAccessories.set(uuid, themeAccessory);
    }

    // Remove stale accessories no longer on the controller
    for (const [uuid, accessory] of this.accessories) {
      if (!discoveredUUIDs.has(uuid)) {
        this.log.info('Removing stale accessory:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
        this.themeAccessories.delete(uuid);
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

    let states: TelemetryGroup[];
    try {
      states = await this.client.getGroupStates();
    } catch (err) {
      this.log.warn('Failed to poll telemetry:', (err as Error).message);
      return;
    }

    // Build a lookup map
    const stateMap = new Map<number, GroupState>();
    for (const s of states) {
      stateMap.set(s.systemId, s.state);
    }

    // Push state to each accessory
    for (const themeAccessory of this.themeAccessories.values()) {
      const group: MSPGroup = themeAccessory.accessory.context.group;
      const state = stateMap.get(group.systemId);
      if (state !== undefined) {
        themeAccessory.updateState(state === GroupState.ON);
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
