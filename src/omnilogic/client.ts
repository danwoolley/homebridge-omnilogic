import { MessageType, MSPGroup, TelemetryGroup } from './types';
import { OmniLogicTransport } from './protocol';
import {
  buildGetConfigPayload,
  buildGetTelemetryPayload,
  buildRunGroupCmdPayload,
  parseGroups,
  parseGroupTelemetry,
} from './xml';

export class OmniLogicClient {
  private transport: OmniLogicTransport;

  constructor(host: string) {
    this.transport = new OmniLogicTransport(host);
  }

  /**
   * Fetch the MSPConfig and return all Group definitions.
   */
  async getGroups(): Promise<MSPGroup[]> {
    const payload = buildGetConfigPayload();
    const response = await this.transport.sendRequest(
      MessageType.REQUEST_CONFIGURATION,
      payload,
      true,
    );
    if (!response) {
      throw new Error('No response from controller for getGroups');
    }
    return parseGroups(response);
  }

  /**
   * Fetch telemetry and return group ON/OFF states.
   */
  async getGroupStates(): Promise<TelemetryGroup[]> {
    const payload = buildGetTelemetryPayload();
    const response = await this.transport.sendRequest(
      MessageType.GET_TELEMETRY,
      payload,
      true,
    );
    if (!response) {
      throw new Error('No response from controller for getGroupStates');
    }
    return parseGroupTelemetry(response);
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

  close(): void {
    this.transport.close();
  }
}
