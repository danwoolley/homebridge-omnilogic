import * as dgram from 'dgram';
import * as zlib from 'zlib';
import {
  HEADER_SIZE,
  PROTOCOL_VERSION,
  CONTROLLER_PORT,
  BLOCK_HEADER_OFFSET,
  ACK_TIMEOUT_MS,
  RETRANSMIT_INTERVAL_MS,
  RETRANSMIT_COUNT,
  FRAGMENT_TIMEOUT_MS,
  MessageType,
  ClientType,
  OmniLogicHeader,
  OmniLogicMessage,
} from './types';
import { LeadMessageInfo } from './types';
import { buildAckPayload, parseLeadMessage } from './xml';

// ── Header packing / unpacking ──────────────────────────────────────

export function packHeader(header: OmniLogicHeader): Buffer {
  const buf = Buffer.alloc(HEADER_SIZE);
  buf.writeUInt32BE(header.msgId, 0);
  buf.writeBigUInt64BE(header.timestamp, 4);
  buf.write(header.version.padEnd(4, '\0'), 12, 4, 'ascii');
  buf.writeUInt32BE(header.msgType, 16);
  buf.writeUInt8(header.clientType, 20);
  buf.writeUInt8(0, 21);
  buf.writeUInt8(header.compressed ? 1 : 0, 22);
  buf.writeUInt8(0, 23);
  return buf;
}

export function unpackHeader(buf: Buffer): OmniLogicHeader {
  return {
    msgId: buf.readUInt32BE(0),
    timestamp: buf.readBigUInt64BE(4),
    version: buf.subarray(12, 16).toString('ascii').replace(/\0/g, ''),
    msgType: buf.readUInt32BE(16) as MessageType,
    clientType: buf.readUInt8(20) as ClientType,
    compressed: buf.readUInt8(22) === 1,
  };
}

function buildMessage(msgType: MessageType, payload: Buffer | null, msgId?: number): Buffer {
  const id = msgId ?? ((Math.random() * 0xFFFFFFFF) >>> 0);
  const timestamp = BigInt(Math.floor(Date.now() / 1000));
  const clientType = payload !== null ? ClientType.XML : ClientType.SIMPLE;

  const header: OmniLogicHeader = {
    msgId: id,
    timestamp,
    version: PROTOCOL_VERSION,
    msgType,
    clientType,
    compressed: false,
  };

  const headerBuf = packHeader(header);
  return payload !== null ? Buffer.concat([headerBuf, payload]) : headerBuf;
}

// ── UDP Transport ───────────────────────────────────────────────────

type MessageHandler = (msg: OmniLogicMessage) => void;

export class OmniLogicTransport {
  private socket: dgram.Socket | null = null;
  private host: string;
  private messageHandler: MessageHandler | null = null;
  private mutex: Promise<void> = Promise.resolve();

  constructor(host: string) {
    this.host = host;
  }

  private ensureSocket(): dgram.Socket {
    if (this.socket) {
      return this.socket;
    }
    const sock = dgram.createSocket('udp4');
    sock.on('message', (data: Buffer) => {
      if (data.length < HEADER_SIZE) {
        return;
      }
      const header = unpackHeader(data);
      const payload = data.subarray(HEADER_SIZE);
      this.messageHandler?.({ header, payload });
    });
    sock.on('error', () => {
      // Errors handled by send/receive timeouts
    });
    this.socket = sock;
    return sock;
  }

  close(): void {
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // Already closed
      }
      this.socket = null;
    }
  }

  /**
   * Send a message and wait for the controller's ACK (msg_type 1002).
   * Retries up to RETRANSMIT_COUNT times.
   */
  private sendWithAck(msgType: MessageType, payload: Buffer | null): Promise<void> {
    return new Promise((resolve, reject) => {
      const message = buildMessage(msgType, payload);
      const sentMsgId = message.readUInt32BE(0);
      const sock = this.ensureSocket();
      let attempts = 0;
      let retransmitTimer: ReturnType<typeof setTimeout> | null = null;
      let ackTimer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (retransmitTimer) {
          clearTimeout(retransmitTimer);
        }
        if (ackTimer) {
          clearTimeout(ackTimer);
        }
        this.messageHandler = null;
      };

      const trySend = () => {
        if (attempts > RETRANSMIT_COUNT) {
          cleanup();
          reject(new Error(`No ACK after ${RETRANSMIT_COUNT + 1} attempts for msgType ${msgType}`));
          return;
        }
        attempts++;
        sock.send(message, 0, message.length, CONTROLLER_PORT, this.host, (err) => {
          if (err) {
            cleanup();
            reject(err);
          }
        });

        // Wait for ACK
        ackTimer = setTimeout(() => {
          // ACK timeout, schedule retransmit
          retransmitTimer = setTimeout(trySend, RETRANSMIT_INTERVAL_MS - ACK_TIMEOUT_MS);
        }, ACK_TIMEOUT_MS);
      };

      this.messageHandler = (msg) => {
        if (msg.header.msgType === MessageType.ACK && msg.header.msgId === sentMsgId) {
          cleanup();
          resolve();
        }
        // If we receive a LeadMessage or TelemetryUpdate instead of ACK,
        // assume ACK was dropped and treat it as success — the caller
        // will handle the response via receiveResponse.
        if (
          msg.header.msgType === MessageType.MSP_LEADMESSAGE ||
          msg.header.msgType === MessageType.MSP_TELEMETRY_UPDATE ||
          msg.header.msgType === MessageType.MSP_CONFIGURATIONUPDATE
        ) {
          cleanup();
          resolve();
        }
      };

      trySend();
    });
  }

  /**
   * Send an XML ACK for a received message (msg_type 0, echoing their msgId).
   */
  private sendAck(receivedMsgId: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const ackPayload = buildAckPayload();
      const message = buildMessage(MessageType.XML_ACK, ackPayload, receivedMsgId);
      const sock = this.ensureSocket();
      sock.send(message, 0, message.length, CONTROLLER_PORT, this.host, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Wait for a single incoming message of a specific type, with timeout.
   */
  private waitForMessage(expectedTypes: MessageType[], timeoutMs: number): Promise<OmniLogicMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.messageHandler = null;
        reject(new Error(`Timeout waiting for message types [${expectedTypes.join(', ')}]`));
      }, timeoutMs);

      this.messageHandler = (msg) => {
        if (expectedTypes.includes(msg.header.msgType)) {
          clearTimeout(timer);
          this.messageHandler = null;
          resolve(msg);
        }
      };
    });
  }

  /**
   * Receive a full response, handling fragmented LeadMessage/BlockMessage protocol.
   * Returns the reassembled (and decompressed if needed) payload as a UTF-8 string.
   */
  private async receiveResponse(): Promise<string> {
    // Wait for the initial response (could be LeadMessage for fragmented, or direct data)
    const first = await this.waitForMessage(
      [MessageType.MSP_LEADMESSAGE, MessageType.MSP_TELEMETRY_UPDATE, MessageType.MSP_CONFIGURATIONUPDATE],
      10_000,
    );

    // Direct (non-fragmented) response
    if (first.header.msgType !== MessageType.MSP_LEADMESSAGE) {
      await this.sendAck(first.header.msgId);
      return this.decodePayload(first);
    }

    // Fragmented response: parse lead message
    const leadXml = first.payload.toString('utf-8').replace(/\0/g, '');
    const lead: LeadMessageInfo = parseLeadMessage(leadXml);

    // ACK the lead message
    await this.sendAck(first.header.msgId);

    // Collect block messages
    const fragments = new Map<number, Buffer>();
    const deadline = Date.now() + FRAGMENT_TIMEOUT_MS;

    while (fragments.size < lead.blockCount) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Fragment timeout: received ${fragments.size}/${lead.blockCount} blocks`);
      }

      const block = await this.waitForMessage([MessageType.MSP_BLOCKMESSAGE], remaining);
      // Strip the 8-byte block sub-header
      const data = block.payload.subarray(BLOCK_HEADER_OFFSET);
      fragments.set(block.header.msgId, data);

      // ACK each block
      await this.sendAck(block.header.msgId);
    }

    // Reassemble in msg_id order
    const sortedKeys = [...fragments.keys()].sort((a, b) => a - b);
    const reassembled = Buffer.concat(sortedKeys.map((k) => fragments.get(k)!));

    // Decompress if needed (check compressed flag from lead, or always for certain types)
    const isCompressed = first.header.compressed || lead.sourceOpId === MessageType.MSP_TELEMETRY_UPDATE;
    if (isCompressed) {
      const decompressed = zlib.inflateSync(reassembled);
      return decompressed.toString('utf-8').replace(/\0/g, '');
    }

    return reassembled.toString('utf-8').replace(/\0/g, '');
  }

  private decodePayload(msg: OmniLogicMessage): string {
    const isCompressed = msg.header.compressed || msg.header.msgType === MessageType.MSP_TELEMETRY_UPDATE;
    if (isCompressed && msg.payload.length > 0) {
      const decompressed = zlib.inflateSync(msg.payload);
      return decompressed.toString('utf-8').replace(/\0/g, '');
    }
    return msg.payload.toString('utf-8').replace(/\0/g, '');
  }

  /**
   * Serialize all requests through a mutex to prevent overlapping UDP conversations.
   */
  async sendRequest(msgType: MessageType, payload: Buffer | null, expectResponse: boolean): Promise<string | null> {
    // Chain onto the mutex
    const result = new Promise<string | null>((resolve, reject) => {
      this.mutex = this.mutex.then(async () => {
        try {
          await this.sendWithAck(msgType, payload);
          if (expectResponse) {
            const response = await this.receiveResponse();
            resolve(response);
          } else {
            resolve(null);
          }
        } catch (err) {
          reject(err);
        }
      });
    });
    return result;
  }
}
