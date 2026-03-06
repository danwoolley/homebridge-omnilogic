// OmniLogic protocol constants, enums, and interfaces

// Network
export const CONTROLLER_PORT = 10444;

// Protocol header
export const HEADER_SIZE = 24;
export const PROTOCOL_VERSION = '1.19';

// Block message: skip 8-byte sub-header in each block payload
export const BLOCK_HEADER_OFFSET = 8;

// Timing (milliseconds)
export const ACK_TIMEOUT_MS = 500;
export const RETRANSMIT_INTERVAL_MS = 2100;
export const RETRANSMIT_COUNT = 5;
export const FRAGMENT_TIMEOUT_MS = 30_000;

// XML namespace
export const XML_NAMESPACE = 'http://nextgen.hayward.com/api';

export enum MessageType {
  XML_ACK = 0,
  REQUEST_CONFIGURATION = 1,
  SET_EQUIPMENT = 164,
  GET_TELEMETRY = 300,
  RUN_GROUP_CMD = 317,
  ACK = 1002,
  MSP_CONFIGURATIONUPDATE = 1003,
  MSP_TELEMETRY_UPDATE = 1004,
  MSP_LEADMESSAGE = 1998,
  MSP_BLOCKMESSAGE = 1999,
}

export enum ClientType {
  XML = 0,    // Messages with XML payload
  SIMPLE = 1, // Messages without payload (bare ACK)
  OMNI = 3,   // Controller responses
}

export enum GroupState {
  OFF = 0,
  ON = 1,
}

export interface OmniLogicHeader {
  msgId: number;
  timestamp: bigint;
  version: string;
  msgType: MessageType;
  clientType: ClientType;
  compressed: boolean;
}

export interface OmniLogicMessage {
  header: OmniLogicHeader;
  payload: Buffer;
}

export interface MSPGroup {
  systemId: number;
  name: string;
}

export interface TelemetryGroup {
  systemId: number;
  state: GroupState;
}

export interface MSPBodyOfWater {
  systemId: number;
  name: string;
}

export interface TelemetryBodyOfWater {
  systemId: number;
  waterTemp: number;
}

export interface LeadMessageInfo {
  sourceOpId: number;
  msgSize: number;
  blockCount: number;
}
