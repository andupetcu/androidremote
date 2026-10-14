import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { Duplex } from 'stream';
import { URL } from 'url';
import type Database from 'better-sqlite3';
import { wsTicketStore } from './services/wsTicketStore';
import { validateSessionToken } from './db/schema';
import { agentConnectionStore, AgentConnection } from './services/agentConnectionStore';
import { deviceStore } from './services/deviceStore';
import { telemetryStore } from './services/telemetryStore';
import { getDatabase } from './db/connection';

// Binary protocol constants (must match agent-core/protocol.rs)
const HEADER_SIZE = 9;

// Message types
const AUTH_REQUEST = 0x01;
const AUTH_RESPONSE = 0x02;
const HEARTBEAT = 0x03;
const HEARTBEAT_ACK = 0x04;
const AGENT_INFO = 0x05;

// Session types
const DESKTOP_OPEN = 0x10;
const DESKTOP_CLOSE = 0x11;
const DESKTOP_FRAME = 0x12;
const DESKTOP_INPUT = 0x13;
const DESKTOP_RESIZE = 0x14;
const DESKTOP_QUALITY = 0x15;

const TERMINAL_OPEN = 0x20;
const TERMINAL_CLOSE = 0x21;
const TERMINAL_DATA = 0x22;
const TERMINAL_RESIZE = 0x23;

const FILE_LIST_REQ = 0x30;
const FILE_LIST_RESP = 0x31;
const FILE_DOWNLOAD_REQ = 0x32;
const FILE_DOWNLOAD_DATA = 0x33;
const FILE_UPLOAD_START = 0x34;
const FILE_UPLOAD_DATA = 0x35;
const FILE_UPLOAD_DONE = 0x36;
const FILE_DELETE_REQ = 0x37;
const FILE_RESULT = 0x38;

const TELEMETRY_REQ = 0x40;
const TELEMETRY_DATA = 0x41;

// Heartbeat interval & timeout
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 90_000;
const STALE_CHECK_INTERVAL_MS = 30_000;

/**
 * Encode a binary protocol message
 */
function encodeMessage(
  type: number,
  channel: number,
  requestId: number,
  payload: Buffer | Uint8Array
): Buffer {
  const buf = Buffer.alloc(HEADER_SIZE + payload.length);
  buf.writeUInt8(type, 0);
  buf.writeUInt16LE(payload.length, 1);
  buf.writeUInt16LE(channel, 3);
  buf.writeUInt32LE(requestId, 5);
  if (payload.length > 0) {
    Buffer.from(payload).copy(buf, HEADER_SIZE);
  }
  return buf;
}

/**
 * Decode a binary protocol message header
 */
function decodeHeader(buf: Buffer): {
  type: number;
  length: number;
  channel: number;
  requestId: number;
} | null {
  if (buf.length < HEADER_SIZE) return null;
  return {
    type: buf.readUInt8(0),
    length: buf.readUInt16LE(1),
    channel: buf.readUInt16LE(3),
    requestId: buf.readUInt32LE(5),
  };
}

/**
 * Build a JSON payload message
 */
function jsonMessage(
  type: number,
  channel: number,
  requestId: number,
  data: object
): Buffer {
  const payload = Buffer.from(JSON.stringify(data), 'utf-8');
  return encodeMessage(type, channel, requestId, payload);
}

// --- Shared WebSocket hardening helpers (also used by signaling.ts) ---

/** Read a positive integer from the environment at call time (so tests and operators can change it). */
export function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Largest message the binary protocol can carry: u16 payload length plus the 9 byte header. */
const RELAY_MAX_PAYLOAD = 70 * 1024;
/** Bytes an unauthenticated relay agent may buffer before AUTH_REQUEST completes. */
const PRE_AUTH_BUFFER_LIMIT = 64 * 1024;
const DEFAULT_AUTH_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

const pingMisses = new WeakMap<WebSocket, number>();

/**
 * Ping every client of `wss` each WS_PING_INTERVAL_MS (default 30 s). A client that has not answered
 * two pings in a row is terminated, so half-open TCP connections cannot pile up. Returns the timer.
 */
export function startPingSweep(wss: WebSocketServer): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      const misses = pingMisses.get(ws) ?? 0;
      if (misses >= 2) {
        ws.terminate();
        continue;
      }
      pingMisses.set(ws, misses + 1);
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, envInt('WS_PING_INTERVAL_MS', 30_000));
  timer.unref?.();
  wss.on('connection', (ws) => {
    pingMisses.set(ws, 0);
    ws.on('pong', () => pingMisses.set(ws, 0));
  });
  wss.on('close', () => clearInterval(timer));
  return timer;
}

/** Reject an HTTP upgrade before any WebSocket exists. */
export function rejectUpgrade(socket: Duplex, status: 401 | 503, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * Send with backpressure protection. When the socket already buffers more than WS_MAX_BUFFERED_BYTES
 * (default 8 MiB) video frames are dropped and anything else closes the slow peer (1013).
 */
export function sendWithBackpressure(ws: WebSocket, data: Buffer | Uint8Array): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > envInt('WS_MAX_BUFFERED_BYTES', DEFAULT_MAX_BUFFERED_BYTES)) {
    if (data[0] === DESKTOP_FRAME) return;
    ws.close(1013, 'slow consumer');
    return;
  }
  ws.send(data);
}

// --- Relay WebSocket Server ---

type SessionType = 'desktop' | 'terminal' | 'files';

interface ViewerAuth {
  deviceId: string;
  sessionType: SessionType;
  subject: string;
}

let relayWss: WebSocketServer;
let staleCheckInterval: ReturnType<typeof setInterval>;
let relayDb: Database.Database | null = null;
const viewerAuths = new WeakMap<IncomingMessage, ViewerAuth>();

function database(): Database.Database {
  return relayDb ?? getDatabase();
}

/**
 * Authenticate a `/relay` HTTP upgrade. Viewers (`deviceId` + `session` in the query) must present a
 * single-use `ticket` of purpose relay bound to that same deviceId. Desktop agents carry no query
 * parameters and authenticate with AUTH_REQUEST after the upgrade, so they pass through here.
 */
export function authenticateRelayUpgrade(request: IncomingMessage): boolean {
  const params = new URL(request.url || '', 'http://relay.invalid').searchParams;
  const deviceId = params.get('deviceId');
  const session = params.get('session');
  if (!deviceId && !session) return true; // agent path
  if (!deviceId || (session !== 'desktop' && session !== 'terminal' && session !== 'files')) return false;
  const ticket = params.get('ticket');
  if (!ticket) return false;
  const claims = wsTicketStore.consume(ticket, 'relay');
  if (!claims || !claims.deviceId || claims.deviceId !== deviceId) return false;
  viewerAuths.set(request, { deviceId, sessionType: session, subject: claims.subject });
  return true;
}

export function relayCapacityAvailable(): boolean {
  return agentConnectionStore.getTotalSessionCount() < envInt('RELAY_MAX_VIEWERS_TOTAL', 200);
}

export function createRelayWss(opts: { db?: Database.Database } = {}): WebSocketServer {
  relayDb = opts.db ?? null;
  relayWss = new WebSocketServer({ noServer: true, maxPayload: RELAY_MAX_PAYLOAD });
  startPingSweep(relayWss);

  relayWss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
    const viewer = viewerAuths.get(request);
    viewerAuths.delete(request);
    if (viewer) {
      handleViewerConnection(ws, viewer);
    } else {
      // Agent connection: waits for the AUTH_REQUEST binary message
      handleAgentConnection(ws);
    }
  });

  // Periodic stale connection cleanup
  staleCheckInterval = setInterval(() => {
    const stale = agentConnectionStore.cleanupStale(HEARTBEAT_TIMEOUT_MS);
    for (const deviceId of stale) {
      console.log(`[Relay] Agent ${deviceId} timed out (no heartbeat)`);
      deviceStore.updateDeviceStatus(deviceId, 'offline');
    }
  }, STALE_CHECK_INTERVAL_MS);

  return relayWss;
}

export function getRelayWss(): WebSocketServer {
  return relayWss;
}

export function shutdownRelay(): void {
  if (staleCheckInterval) {
    clearInterval(staleCheckInterval);
  }
  if (relayWss) {
    relayWss.close();
  }
}

/** Close the relay agent of a device and all its viewers (unenroll / revoke). */
export function disconnectRelayDevice(deviceId: string, reason: string): boolean {
  return agentConnectionStore.disconnectDevice(deviceId, reason);
}

// --- Agent Connection Handling ---

function handleAgentConnection(ws: WebSocket): void {
  console.log('[Relay] New agent connection, waiting for AUTH_REQUEST...');

  let authenticated = false;
  let deviceId: string | null = null;
  let readBuffer = Buffer.alloc(0);

  let authPending = false;

  // Stays armed until authentication succeeds or fails; a partial AUTH_REQUEST does not disarm it
  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      console.log('[Relay] Agent auth timeout');
      ws.close(4001, 'authentication timeout');
    }
  }, envInt('RELAY_AUTH_TIMEOUT_MS', DEFAULT_AUTH_TIMEOUT_MS));

  ws.on('message', (data: Buffer) => {
    // Accumulate data in read buffer
    readBuffer = Buffer.concat([readBuffer, data]);
    if (!authenticated && readBuffer.length > PRE_AUTH_BUFFER_LIMIT) {
      clearTimeout(authTimeout);
      ws.close(1009, 'pre-auth buffer limit');
      return;
    }

    // Process complete messages
    while (readBuffer.length >= HEADER_SIZE) {
      const header = decodeHeader(readBuffer);
      if (!header) break;

      const totalSize = HEADER_SIZE + header.length;
      if (readBuffer.length < totalSize) break;

      const payload = readBuffer.subarray(HEADER_SIZE, totalSize);
      readBuffer = readBuffer.subarray(totalSize);

      if (!authenticated) {
        // Only accept AUTH_REQUEST before authentication
        if (header.type === AUTH_REQUEST && !authPending) {
          authPending = true;
          handleAgentAuth(ws, payload, header.requestId).then((result) => {
            clearTimeout(authTimeout);
            if (result && ws.readyState === WebSocket.OPEN) {
              authenticated = true;
              deviceId = result;
            } else {
              if (result) agentConnectionStore.removeAgentIfSocket(result, ws);
              ws.close(4003, 'authentication failed');
            }
          });
        }
        continue;
      }

      // Authenticated agent message handling
      handleAgentMessage(deviceId!, header, payload);
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    if (deviceId) {
      console.log(`[Relay] Agent ${deviceId} disconnected`);
      // Only the socket that owns the registration may tear it down (a replaced socket closes late)
      if (agentConnectionStore.removeAgentIfSocket(deviceId, ws)) {
        deviceStore.updateDeviceStatus(deviceId, 'offline');
      }
    }
  });

  ws.on('error', (err) => {
    console.error(`[Relay] Agent WebSocket error:`, err.message);
    if (deviceId && agentConnectionStore.removeAgentIfSocket(deviceId, ws)) {
      deviceStore.updateDeviceStatus(deviceId, 'offline');
    }
  });
}

async function handleAgentAuth(
  ws: WebSocket,
  payload: Buffer,
  requestId: number
): Promise<string | null> {
  try {
    const auth = JSON.parse(payload.toString('utf-8'));
    const { token, agent_version, os, arch, hostname } = auth;

    if (!token) {
      sendAuthResponse(ws, requestId, false, undefined, undefined, 'missing token');
      return null;
    }

    // Validate the session token (must exist and not be expired)
    const db = database();
    const deviceId = typeof token === 'string' ? validateSessionToken(db, token) : null;

    if (!deviceId) {
      sendAuthResponse(ws, requestId, false, undefined, undefined, 'invalid session token');
      return null;
    }

    // Verify device exists
    const device = deviceStore.getDevice(deviceId);
    if (!device) {
      sendAuthResponse(ws, requestId, false, undefined, undefined, 'device not found');
      return null;
    }

    // Register the connection
    agentConnectionStore.addAgent(deviceId, ws, {
      agentVersion: agent_version || 'unknown',
      os: os || 'unknown',
      arch: arch || 'unknown',
      hostname: hostname || 'unknown',
    });

    // Update device status
    deviceStore.updateLastSeen(deviceId);

    // Update OS-specific fields if present
    if (os || hostname || agent_version || arch) {
      try {
        db.prepare(`
          UPDATE devices SET
            os_type = COALESCE(?, os_type),
            hostname = COALESCE(?, hostname),
            agent_version = COALESCE(?, agent_version),
            arch = COALESCE(?, arch)
          WHERE id = ?
        `).run(os || null, hostname || null, agent_version || null, arch || null, deviceId);
      } catch {
        // Non-critical: columns may not exist yet if migration hasn't run
      }
    }

    console.log(
      `[Relay] Agent authenticated: deviceId=${deviceId}, os=${os}, arch=${arch}, hostname=${hostname}`
    );

    sendAuthResponse(ws, requestId, true, deviceId, token);

    // Start heartbeat for this agent
    startAgentHeartbeat(ws, deviceId);

    return deviceId;
  } catch (err) {
    console.error('[Relay] Auth error:', err);
    sendAuthResponse(ws, requestId, false, undefined, undefined, 'internal error');
    return null;
  }
}

function sendAuthResponse(
  ws: WebSocket,
  requestId: number,
  success: boolean,
  deviceId?: string,
  sessionToken?: string,
  error?: string
): void {
  const payload: Record<string, unknown> = { success };
  if (deviceId) payload.device_id = deviceId;
  if (sessionToken) payload.session_token = sessionToken;
  if (error) payload.error = error;

  const msg = jsonMessage(AUTH_RESPONSE, 0, requestId, payload);
  sendBinary(ws, msg);
}

function startAgentHeartbeat(ws: WebSocket, deviceId: string): void {
  const interval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      clearInterval(interval);
      return;
    }
    const msg = encodeMessage(HEARTBEAT, 0, 0, Buffer.alloc(0));
    sendBinary(ws, msg);
  }, HEARTBEAT_INTERVAL_MS);

  ws.on('close', () => clearInterval(interval));
}

function handleAgentMessage(
  deviceId: string,
  header: { type: number; length: number; channel: number; requestId: number },
  payload: Buffer
): void {
  const conn = agentConnectionStore.getAgent(deviceId);
  if (!conn) return;

  switch (header.type) {
    case HEARTBEAT_ACK:
      agentConnectionStore.updateHeartbeat(deviceId);
      deviceStore.updateLastSeen(deviceId);
      break;

    case HEARTBEAT:
      // Agent sent heartbeat, respond with ACK
      {
        const ack = encodeMessage(HEARTBEAT_ACK, 0, 0, Buffer.alloc(0));
        sendBinary(conn.ws, ack);
        agentConnectionStore.updateHeartbeat(deviceId);
        deviceStore.updateLastSeen(deviceId);
      }
      break;

    case AGENT_INFO:
      handleAgentInfo(deviceId, payload);
      break;

    case TELEMETRY_DATA:
      handleAgentTelemetry(deviceId, payload);
      relayToViewer(conn, header, payload);
      break;

    // Session messages — relay to viewer on the corresponding channel
    case DESKTOP_FRAME:
    case DESKTOP_RESIZE:
    case TERMINAL_DATA:
    case TERMINAL_CLOSE:
    case FILE_LIST_RESP:
    case FILE_DOWNLOAD_DATA:
    case FILE_UPLOAD_DONE:
    case FILE_RESULT:
    case 0x07: // COMMAND_RESULT
      relayToViewer(conn, header, payload);
      break;

    default:
      console.log(
        `[Relay] Unknown agent message type: 0x${header.type.toString(16)}`
      );
  }
}

function handleAgentInfo(deviceId: string, payload: Buffer): void {
  try {
    const info = JSON.parse(payload.toString('utf-8'));
    console.log(
      `[Relay] Agent info for ${deviceId}: ${info.hostname} (${info.os_name} ${info.os_version})`
    );

    // Update device info in database
    const db = database();
    try {
      db.prepare(`
        UPDATE devices SET
          hostname = COALESCE(?, hostname),
          os_type = COALESCE(?, os_type),
          agent_version = COALESCE(?, agent_version),
          arch = COALESCE(?, arch)
        WHERE id = ?
      `).run(
        info.hostname || null,
        info.os_name || null,
        info.agent_version || null,
        info.arch || null,
        deviceId
      );
    } catch {
      // Non-critical
    }
  } catch (err) {
    console.error(`[Relay] Failed to parse agent info:`, err);
  }
}

function handleAgentTelemetry(deviceId: string, payload: Buffer): void {
  try {
    const data = JSON.parse(payload.toString('utf-8'));
    console.log(
      `[Relay] Telemetry from ${deviceId}: cpu=${data.cpu?.usage_percent?.toFixed(1)}%, mem=${data.memory?.used_bytes}/${data.memory?.total_bytes}`
    );

    // Map agent telemetry into the existing telemetry store
    // Overlap: memory, uptime. Agent also provides CPU, disks, network (stored as JSON).
    telemetryStore.updateTelemetry({
      deviceId,
      memoryUsedBytes: data.memory?.used_bytes ?? undefined,
      memoryTotalBytes: data.memory?.total_bytes ?? undefined,
      uptimeMs: data.uptime_ms ?? undefined,
      // Store first disk as storage info
      storageUsedBytes: data.disks?.[0]?.used_bytes ?? undefined,
      storageTotalBytes: data.disks?.[0]?.total_bytes ?? undefined,
      // Store first network interface IP
      ipAddress: data.network?.[0]?.ipv4 ?? data.network?.[0]?.ipv6 ?? undefined,
    });

    // Store full telemetry JSON for rich display
    try {
      const db = database();
      db.prepare(`
        UPDATE devices SET agent_telemetry_json = ? WHERE id = ?
      `).run(JSON.stringify(data), deviceId);
    } catch {
      // Non-critical: column may not exist yet
    }
  } catch (err) {
    console.error(`[Relay] Failed to parse agent telemetry:`, err);
  }
}

function relayToViewer(
  conn: AgentConnection,
  header: { type: number; length: number; channel: number; requestId: number },
  payload: Buffer
): void {
  if (header.channel === 0) {
    // Control channel messages — broadcast to all viewers? Or drop.
    // For COMMAND_RESULT / TELEMETRY_DATA on channel 0, find the right viewer by requestId
    // For now, broadcast to all active sessions
    for (const [, session] of conn.activeSessions) {
      const msg = encodeMessage(
        header.type,
        session.channelId,
        header.requestId,
        payload
      );
      sendBinary(session.ws, msg);
    }
    return;
  }

  const session = conn.activeSessions.get(header.channel);
  if (!session) {
    // No viewer for this channel
    return;
  }

  // Forward the raw message to the viewer
  const msg = encodeMessage(
    header.type,
    header.channel,
    header.requestId,
    payload
  );
  sendBinary(session.ws, msg);
}

// --- Viewer Connection Handling ---

function handleViewerConnection(ws: WebSocket, viewer: ViewerAuth): void {
  const { deviceId, sessionType } = viewer;
  const userId = viewer.subject;

  // Check if agent is connected
  const conn = agentConnectionStore.getAgent(deviceId);
  if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
    console.log(`[Relay] Viewer requested device ${deviceId} but agent is not connected`);
    ws.close(4004, 'agent not connected');
    return;
  }

  if (
    conn.activeSessions.size >= envInt('RELAY_MAX_VIEWERS_PER_DEVICE', 3) ||
    !relayCapacityAvailable()
  ) {
    ws.close(4006, 'too many sessions');
    return;
  }

  // Allocate channel
  const channelId = agentConnectionStore.allocateChannel(
    deviceId,
    ws,
    sessionType,
    userId
  );
  if (channelId === null) {
    ws.close(4005, 'failed to allocate channel');
    return;
  }

  console.log(
    `[Relay] Viewer ${userId} connected to ${deviceId} (${sessionType}, channel ${channelId})`
  );

  // Send OPEN command to agent
  sendSessionOpen(conn, channelId, sessionType);

  // Relay viewer messages to agent
  ws.on('message', (data: Buffer) => {
    if (conn.ws.readyState !== WebSocket.OPEN) {
      ws.close(4004, 'agent disconnected');
      return;
    }

    // Parse the incoming message to get the type, then forward with the correct channel
    if (data.length >= HEADER_SIZE) {
      const header = decodeHeader(data);
      if (header) {
        // A viewer may only send message types that belong to its own session type
        if (!viewerMaySend(sessionType, header.type)) return;
        // Rewrite the channel to match what the agent expects
        const payload = data.subarray(HEADER_SIZE, HEADER_SIZE + header.length);
        const relayed = encodeMessage(
          header.type,
          channelId,
          header.requestId,
          payload
        );
        sendBinary(conn.ws, relayed);
        return;
      }
    }

    // Not a valid protocol message: drop it
  });

  ws.on('close', () => {
    console.log(
      `[Relay] Viewer ${userId} disconnected from ${deviceId} (channel ${channelId})`
    );
    agentConnectionStore.removeSession(deviceId, channelId);

    // Send CLOSE to agent
    sendSessionClose(conn, channelId, sessionType);
  });

  ws.on('error', () => {
    agentConnectionStore.removeSession(deviceId, channelId);
    sendSessionClose(conn, channelId, sessionType);
  });
}

/** Message type ranges a viewer of each session type may forward to the agent (plus telemetry requests). */
function viewerMaySend(sessionType: SessionType, type: number): boolean {
  if (type === TELEMETRY_REQ) return true;
  switch (sessionType) {
    case 'desktop':
      return type >= 0x10 && type <= 0x1f;
    case 'terminal':
      return type >= 0x20 && type <= 0x2f;
    case 'files':
      return type >= 0x30 && type <= 0x3f;
  }
}

function sendSessionOpen(
  conn: AgentConnection,
  channelId: number,
  sessionType: SessionType
): void {
  let type: number;
  let payload: object;

  switch (sessionType) {
    case 'desktop':
      type = DESKTOP_OPEN;
      payload = { quality: 70, fps: 15, encoding: 'jpeg' };
      break;
    case 'terminal':
      type = TERMINAL_OPEN;
      payload = { shell: null, cols: 80, rows: 24 };
      break;
    case 'files':
      type = FILE_LIST_REQ;
      payload = { path: '/' };
      break;
    default:
      return;
  }

  const msg = jsonMessage(type, channelId, 0, payload);
  sendBinary(conn.ws, msg);
}

function sendSessionClose(
  conn: AgentConnection,
  channelId: number,
  sessionType: SessionType
): void {
  if (conn.ws.readyState !== WebSocket.OPEN) return;

  let type: number;
  switch (sessionType) {
    case 'desktop':
      type = DESKTOP_CLOSE;
      break;
    case 'terminal':
      type = TERMINAL_CLOSE;
      break;
    default:
      return;
  }

  const msg = encodeMessage(type, channelId, 0, Buffer.alloc(0));
  sendBinary(conn.ws, msg);
}

// --- Utilities ---

function sendBinary(ws: WebSocket, data: Buffer | Uint8Array): void {
  sendWithBackpressure(ws, data);
}
