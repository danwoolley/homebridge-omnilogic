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

export interface MSPLight {
  systemId: number;
  name: string;
  bowSystemId: number;
}

export interface TelemetryLight {
  systemId: number;
  lightState: number;  // 0=off; 1=powering off (stage 1); 3=transitioning?; 4=15 seconds of white light; 6=on; 7=powering off (stage 2)
  currentShow: number;  // 0-26
  speed: number;  // 0=1/16x; 1=1/8x; 2=1/4x; 3=1/2x; 4=1x; 5=2x; 6=4x; 7=8x; 8=16x
  brightness: number;  // 0=20%; 1=40%, 2=60%, 3=80%, 4=100%
  specialEffect: number;  // No known meaning, always 0 in my testing
}

export interface LeadMessageInfo {
  sourceOpId: number;
  msgSize: number;
  blockCount: number;
}
