/**
 * Binary protocol encoder/decoder — mirrors agent-core/protocol.rs
 *
 * Wire format: [u8 type][u16 length LE][u16 channel LE][u32 request_id LE][payload...]
 * Header: 9 bytes total
 */

export const HEADER_SIZE = 9;

// --- Message Types ---

// Control plane (channel 0)
export const AUTH_REQUEST = 0x01;
export const AUTH_RESPONSE = 0x02;
export const HEARTBEAT = 0x03;
export const HEARTBEAT_ACK = 0x04;
export const AGENT_INFO = 0x05;
export const COMMAND = 0x06;
export const COMMAND_RESULT = 0x07;

// Desktop (channel 1+)
export const DESKTOP_OPEN = 0x10;
export const DESKTOP_CLOSE = 0x11;
export const DESKTOP_FRAME = 0x12;
export const DESKTOP_INPUT = 0x13;
export const DESKTOP_RESIZE = 0x14;
export const DESKTOP_QUALITY = 0x15;

// Terminal (channel 1+)
export const TERMINAL_OPEN = 0x20;
export const TERMINAL_CLOSE = 0x21;
export const TERMINAL_DATA = 0x22;
export const TERMINAL_RESIZE = 0x23;

// Files (channel 0)
export const FILE_LIST_REQ = 0x30;
export const FILE_LIST_RESP = 0x31;
export const FILE_DOWNLOAD_REQ = 0x32;
export const FILE_DOWNLOAD_DATA = 0x33;
export const FILE_UPLOAD_START = 0x34;
export const FILE_UPLOAD_DATA = 0x35;
export const FILE_UPLOAD_DONE = 0x36;
export const FILE_DELETE_REQ = 0x37;
export const FILE_RESULT = 0x38;

// Telemetry (channel 0)
export const TELEMETRY_REQ = 0x40;
export const TELEMETRY_DATA = 0x41;

// Desktop input sub-types
export const INPUT_MOUSE_MOVE = 0x01;
export const INPUT_MOUSE_BUTTON = 0x02;
export const INPUT_MOUSE_SCROLL = 0x03;
export const INPUT_KEY_EVENT = 0x04;
export const INPUT_TYPE_TEXT = 0x05;

// --- Interfaces ---

export interface MessageHeader {
  type: number;
  length: number;
  channel: number;
  requestId: number;
}

export interface ProtocolMessage {
  header: MessageHeader;
  payload: Uint8Array;
}

// --- Encoding ---

/**
 * Encode a protocol message into a binary buffer
 */
export function encode(
  type: number,
  channel: number,
  requestId: number,
  payload: Uint8Array | ArrayBuffer
): ArrayBuffer {
  const payloadBytes =
    payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const buf = new ArrayBuffer(HEADER_SIZE + payloadBytes.length);
  const view = new DataView(buf);

  view.setUint8(0, type);
  view.setUint16(1, payloadBytes.length, true); // LE
  view.setUint16(3, channel, true); // LE
  view.setUint32(5, requestId, true); // LE

  const arr = new Uint8Array(buf);
  arr.set(payloadBytes, HEADER_SIZE);

  return buf;
}

/**
 * Encode a JSON payload message
 */
export function encodeJson(
  type: number,
  channel: number,
  requestId: number,
  data: unknown
): ArrayBuffer {
  const json = JSON.stringify(data);
  const payload = new TextEncoder().encode(json);
  return encode(type, channel, requestId, payload);
}

/**
 * Encode terminal data (raw bytes)
 */
export function encodeTerminalData(
  channel: number,
  data: Uint8Array | string
): ArrayBuffer {
  const payload =
    typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return encode(TERMINAL_DATA, channel, 0, payload);
}

/**
 * Encode terminal resize
 */
export function encodeTerminalResize(
  channel: number,
  cols: number,
  rows: number
): ArrayBuffer {
  const payload = new ArrayBuffer(4);
  const view = new DataView(payload);
  view.setUint16(0, cols, true);
  view.setUint16(2, rows, true);
  return encode(TERMINAL_RESIZE, channel, 0, new Uint8Array(payload));
}

// --- Decoding ---

/**
 * Decode a message header from a buffer.
 * Returns null if buffer is too short.
 */
export function decodeHeader(buf: ArrayBuffer | Uint8Array): MessageHeader | null {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.length < HEADER_SIZE) return null;

  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  );

  return {
    type: view.getUint8(0),
    length: view.getUint16(1, true),
    channel: view.getUint16(3, true),
    requestId: view.getUint32(5, true),
  };
}

/**
 * Decode a complete message from a buffer.
 * Returns null if not enough data.
 * Returns [message, bytesConsumed] on success.
 */
export function decode(
  buf: ArrayBuffer | Uint8Array
): [ProtocolMessage, number] | null {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.length < HEADER_SIZE) return null;

  const header = decodeHeader(bytes)!;
  const totalSize = HEADER_SIZE + header.length;

  if (bytes.length < totalSize) return null;

  const payload = bytes.slice(HEADER_SIZE, totalSize);

  return [{ header, payload }, totalSize];
}

/**
 * Decode all complete messages from a buffer.
 * Returns the messages and the remaining bytes.
 */
export function decodeAll(
  buf: Uint8Array
): { messages: ProtocolMessage[]; remaining: Uint8Array } {
  const messages: ProtocolMessage[] = [];
  let offset = 0;

  while (offset < buf.length) {
    const result = decode(buf.subarray(offset));
    if (!result) break;

    const [msg, consumed] = result;
    messages.push(msg);
    offset += consumed;
  }

  return {
    messages,
    remaining: buf.subarray(offset),
  };
}

/**
 * Parse a message payload as JSON
 */
export function parseJsonPayload<T = unknown>(msg: ProtocolMessage): T {
  const text = new TextDecoder().decode(msg.payload);
  return JSON.parse(text) as T;
}

/**
 * Get a human-readable name for a message type
 */
export function typeName(type: number): string {
  const names: Record<number, string> = {
    [AUTH_REQUEST]: 'AUTH_REQUEST',
    [AUTH_RESPONSE]: 'AUTH_RESPONSE',
    [HEARTBEAT]: 'HEARTBEAT',
    [HEARTBEAT_ACK]: 'HEARTBEAT_ACK',
    [AGENT_INFO]: 'AGENT_INFO',
    [COMMAND]: 'COMMAND',
    [COMMAND_RESULT]: 'COMMAND_RESULT',
    [DESKTOP_OPEN]: 'DESKTOP_OPEN',
    [DESKTOP_CLOSE]: 'DESKTOP_CLOSE',
    [DESKTOP_FRAME]: 'DESKTOP_FRAME',
    [DESKTOP_INPUT]: 'DESKTOP_INPUT',
    [DESKTOP_RESIZE]: 'DESKTOP_RESIZE',
    [DESKTOP_QUALITY]: 'DESKTOP_QUALITY',
    [TERMINAL_OPEN]: 'TERMINAL_OPEN',
    [TERMINAL_CLOSE]: 'TERMINAL_CLOSE',
    [TERMINAL_DATA]: 'TERMINAL_DATA',
    [TERMINAL_RESIZE]: 'TERMINAL_RESIZE',
    [FILE_LIST_REQ]: 'FILE_LIST_REQ',
    [FILE_LIST_RESP]: 'FILE_LIST_RESP',
    [FILE_DOWNLOAD_REQ]: 'FILE_DOWNLOAD_REQ',
    [FILE_DOWNLOAD_DATA]: 'FILE_DOWNLOAD_DATA',
    [FILE_UPLOAD_START]: 'FILE_UPLOAD_START',
    [FILE_UPLOAD_DATA]: 'FILE_UPLOAD_DATA',
    [FILE_UPLOAD_DONE]: 'FILE_UPLOAD_DONE',
    [FILE_DELETE_REQ]: 'FILE_DELETE_REQ',
    [FILE_RESULT]: 'FILE_RESULT',
    [TELEMETRY_REQ]: 'TELEMETRY_REQ',
    [TELEMETRY_DATA]: 'TELEMETRY_DATA',
  };
  return names[type] || `UNKNOWN(0x${type.toString(16)})`;
}
