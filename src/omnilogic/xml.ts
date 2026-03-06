import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { MSPGroup, TelemetryGroup, GroupState, MSPBodyOfWater, TelemetryBodyOfWater, LeadMessageInfo } from './types';

const parserOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
};
const parser = new XMLParser(parserOptions);

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  suppressEmptyNode: true,
  format: false,
});

/**
 * Build an XML request payload for the OmniLogic controller.
 * Returns a null-terminated UTF-8 Buffer.
 */
export function buildRequest(name: string, params?: Record<string, { dataType: string; value: string | number }>): Buffer {
  const reqObj: Record<string, unknown> = {
    '?xml': { '@_version': '1.0', '@_encoding': 'unicode' },
    Request: {
      '@_xmlns': 'http://nextgen.hayward.com/api',
      Name: name,
    } as Record<string, unknown>,
  };

  if (params) {
    const paramList = Object.entries(params).map(([pName, p]) => ({
      '@_name': pName,
      '@_dataType': p.dataType,
      '#text': String(p.value),
    }));
    (reqObj.Request as Record<string, unknown>).Parameters = { Parameter: paramList };
  }

  const xml = builder.build(reqObj) as string;
  return Buffer.from(xml + '\0', 'utf-8');
}

export function buildAckPayload(): Buffer {
  return buildRequest('Ack');
}

export function buildGetConfigPayload(): Buffer {
  return buildRequest('RequestConfiguration');
}

export function buildGetTelemetryPayload(): Buffer {
  return buildRequest('RequestTelemetryData');
}

export function buildRunGroupCmdPayload(groupId: number, on: boolean): Buffer {
  return buildRequest('RunGroupCmd', {
    GroupID: { dataType: 'int', value: groupId },
    Data: { dataType: 'int', value: on ? 1 : 0 },
    IsCountDownTimer: { dataType: 'bool', value: 0 },
    StartTimeHours: { dataType: 'int', value: 0 },
    StartTimeMinutes: { dataType: 'int', value: 0 },
    EndTimeHours: { dataType: 'int', value: 0 },
    EndTimeMinutes: { dataType: 'int', value: 0 },
    DaysActive: { dataType: 'int', value: 0 },
    Recurring: { dataType: 'bool', value: 0 },
  });
}

/**
 * Parse MSPConfig XML to extract Group definitions.
 */
export function parseGroups(mspConfigXml: string): MSPGroup[] {
  const parsed = parser.parse(mspConfigXml);
  const groups = parsed?.MSPConfig?.Groups?.Group;
  if (!groups) {
    return [];
  }

  const groupList = Array.isArray(groups) ? groups : [groups];
  return groupList.map((g: Record<string, unknown>) => ({
    systemId: Number(g['System-Id']),
    name: String(g['Name'] ?? `Group ${g['System-Id']}`),
  }));
}

/**
 * Parse telemetry XML to extract group ON/OFF states.
 */
export function parseGroupTelemetry(telemetryXml: string): TelemetryGroup[] {
  const parsed = parser.parse(telemetryXml);
  const status = parsed?.STATUS;
  if (!status) {
    return [];
  }

  const groups = status.Group;
  if (!groups) {
    return [];
  }

  const groupList = Array.isArray(groups) ? groups : [groups];
  return groupList.map((g: Record<string, unknown>) => ({
    systemId: Number(g['@_systemId']),
    state: Number(g['@_groupState']) as GroupState,
  }));
}

/**
 * Parse MSPConfig XML to extract Body-of-water definitions from Backyard.
 */
export function parseBodiesOfWater(mspConfigXml: string): MSPBodyOfWater[] {
  const parsed = parser.parse(mspConfigXml);
  const backyard = parsed?.MSPConfig?.Backyard;
  if (!backyard) {
    return [];
  }

  const bodies = backyard['Body-of-water'];
  if (!bodies) {
    return [];
  }

  const bodyList = Array.isArray(bodies) ? bodies : [bodies];
  return bodyList.map((b: Record<string, unknown>) => ({
    systemId: Number(b['System-Id']),
    name: String(b['Name'] ?? `Body of Water ${b['System-Id']}`),
  }));
}

/**
 * Parse telemetry XML to extract BodyOfWater water temperatures.
 */
export function parseBodyOfWaterTelemetry(telemetryXml: string): TelemetryBodyOfWater[] {
  const parsed = parser.parse(telemetryXml);
  const status = parsed?.STATUS;
  if (!status) {
    return [];
  }

  const bodies = status.BodyOfWater;
  if (!bodies) {
    return [];
  }

  const bodyList = Array.isArray(bodies) ? bodies : [bodies];
  return bodyList.map((b: Record<string, unknown>) => ({
    systemId: Number(b['@_systemId']),
    waterTemp: Number(b['@_waterTemp']),
  }));
}

/**
 * Parse a LeadMessage XML response to get block count and total size.
 */
export function parseLeadMessage(xml: string): LeadMessageInfo {
  const parsed = parser.parse(xml);
  const params = parsed?.Response?.Parameters?.Parameter;
  if (!params) {
    throw new Error('Invalid LeadMessage XML');
  }

  const paramList = Array.isArray(params) ? params : [params];
  const paramMap = new Map<string, string>();
  for (const p of paramList) {
    paramMap.set(p['@_name'], String(p['#text']));
  }

  return {
    sourceOpId: Number(paramMap.get('SourceOpId') ?? 0),
    msgSize: Number(paramMap.get('MsgSize') ?? 0),
    blockCount: Number(paramMap.get('MsgBlockCount') ?? 0),
  };
}
