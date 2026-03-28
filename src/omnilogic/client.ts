import { MessageType, MSPGroup, TelemetryGroup } from './types';
import { OmniLogicTransport } from './protocol';
import {
  buildGetConfigPayload,
  buildGetTelemetryPayload,
  buildRunGroupCmdPayload,
  buildSetEquipmentPayload,
  parseGroups,
  parseGroupTelemetry,
} from './xml';

export class OmniLogicClient {
  private transport: OmniLogicTransport;

  constructor(host: string) {
    this.transport = new OmniLogicTransport(host);
  }

  /**
   * Fetch the raw MSPConfig XML from the controller.
   */
  async getConfig(): Promise<string> {
    const payload = buildGetConfigPayload();
    const response = await this.transport.sendRequest(
      MessageType.REQUEST_CONFIGURATION,
      payload,
      true,
    );
    if (!response) {
      throw new Error('No response from controller for getConfig');
    }
    return response;
  }

  /**
   * Fetch the raw telemetry XML from the controller.
   */
  async getTelemetry(): Promise<string> {
    const payload = buildGetTelemetryPayload();
    const response = await this.transport.sendRequest(
      MessageType.GET_TELEMETRY,
      payload,
      true,
    );
    if (!response) {
      throw new Error('No response from controller for getTelemetry');
    }
    return response;
  }

  /**
   * Fetch the MSPConfig and return all Group definitions.
   */
  async getGroups(): Promise<MSPGroup[]> {
    const xml = await this.getConfig();
    return parseGroups(xml);
  }

  /**
   * Fetch telemetry and return group ON/OFF states.
   */
  async getGroupStates(): Promise<TelemetryGroup[]> {
    const xml = await this.getTelemetry();
    return parseGroupTelemetry(xml);
  }

  /**
   * Turn a group/theme ON or OFF.
   * Fire-and-forget — no response expected.
   */
  async setGroupState(groupId: number, on: boolean): Promise<void> {
    const payload = buildRunGroupCmdPayload(groupId, on);
    await this.transport.sendRequest(
      MessageType.RUN_GROUP_CMD,
      payload,
      false,
    );
  }

  /**
   * Turn a ColorLogic light ON or OFF.
   * Fire-and-forget — no response expected.
   */
  async setLightState(bowId: number, equipmentId: number, on: boolean): Promise<void> {
    const payload = buildSetEquipmentPayload(bowId, equipmentId, on);
    await this.transport.sendRequest(MessageType.SET_EQUIPMENT, payload, false);
  }

  close(): void {
    this.transport.close();
  }
}
