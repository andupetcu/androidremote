import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { URL } from 'url';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from './middleware/auth';
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

// --- Relay WebSocket Server ---

let relayWss: WebSocketServer;
let staleCheckInterval: ReturnType<typeof setInterval>;

export function createRelayWss(): WebSocketServer {
  relayWss = new WebSocketServer({ noServer: true });

  relayWss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    const params = url.searchParams;

    // Determine if this is an agent or viewer connection
    const deviceIdParam = params.get('deviceId');
    const sessionType = params.get('session') as
      | 'desktop'
      | 'terminal'
      | 'files'
      | null;
    const token = params.get('token');

    if (deviceIdParam && sessionType && token) {
      // Viewer connection
      handleViewerConnection(ws, deviceIdParam, sessionType, token);
    } else {
      // Agent connection — waits for AUTH_REQUEST binary message
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

// --- Agent Connection Handling ---

function handleAgentConnection(ws: WebSocket): void {
  console.log('[Relay] New agent connection, waiting for AUTH_REQUEST...');

  let authenticated = false;
  let deviceId: string | null = null;
  let readBuffer = Buffer.alloc(0);

  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      console.log('[Relay] Agent auth timeout');
      ws.close(4001, 'authentication timeout');
    }
  }, 10_000);

  ws.on('message', (data: Buffer) => {
    // Accumulate data in read buffer
    readBuffer = Buffer.concat([readBuffer, data]);

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
        if (header.type === AUTH_REQUEST) {
          clearTimeout(authTimeout);
          handleAgentAuth(ws, payload, header.requestId).then((result) => {
            if (result) {
              authenticated = true;
              deviceId = result;
            } else {
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
      agentConnectionStore.removeAgent(deviceId);
      deviceStore.updateDeviceStatus(deviceId, 'offline');
    }
  });

  ws.on('error', (err) => {
    console.error(`[Relay] Agent WebSocket error:`, err.message);
    if (deviceId) {
      agentConnectionStore.removeAgent(deviceId);
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

    // Validate session token against the sessions table
    const db = getDatabase();
    const session = db
      .prepare('SELECT device_id FROM sessions WHERE token = ?')
      .get(token) as { device_id: string } | undefined;

    if (!session) {
      sendAuthResponse(ws, requestId, false, undefined, undefined, 'invalid session token');
      return null;
    }

    const deviceId = session.device_id;

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
    const db = getDatabase();
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
      const db = getDatabase();
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

function handleViewerConnection(
  ws: WebSocket,
  deviceId: string,
  sessionType: 'desktop' | 'terminal' | 'files',
  token: string
): void {
  // Validate JWT token
  let userId: string;
  try {
    // Try to validate as JWT
    const decoded = jwt.verify(token, getJwtSecret()) as { username?: string; sub?: string };
    userId = decoded.username || decoded.sub || 'admin';
  } catch {
    // Also accept session tokens (for simpler auth)
    const db = getDatabase();
    const session = db
      .prepare('SELECT device_id FROM sessions WHERE token = ?')
      .get(token) as { device_id: string } | undefined;
    if (!session) {
      console.log('[Relay] Viewer auth failed: invalid token');
      ws.close(4003, 'authentication failed');
      return;
    }
    userId = 'agent-session';
  }

  // Check if agent is connected
  const conn = agentConnectionStore.getAgent(deviceId);
  if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
    console.log(`[Relay] Viewer requested device ${deviceId} but agent is not connected`);
    ws.close(4004, 'agent not connected');
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

    // If not a valid protocol message, just forward raw
    sendBinary(conn.ws, data);
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
  });
}

function sendSessionOpen(
  conn: AgentConnection,
  channelId: number,
  sessionType: 'desktop' | 'terminal' | 'files'
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
  sessionType: 'desktop' | 'terminal' | 'files'
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
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(data);
  }
}
