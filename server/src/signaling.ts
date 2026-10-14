import { WebSocketServer, WebSocket } from 'ws';
import { Server, IncomingMessage } from 'http';
import type Database from 'better-sqlite3';
import { eventStore, DeviceEvent } from './services/eventStore';
import { commandStore } from './services/commandStore';
import { wsTicketStore } from './services/wsTicketStore';
import { validateSessionToken } from './db/schema';
import { getDatabase } from './db/connection';
import {
  createRelayWss,
  authenticateRelayUpgrade,
  relayCapacityAvailable,
  rejectUpgrade,
  startPingSweep,
  envInt,
  disconnectRelayDevice,
} from './relay';

// ICE candidate as received from WebRTC (browser-agnostic definition)
interface IceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

interface SignalingMessage {
  type: 'join' | 'offer' | 'answer' | 'ice-candidate';
  deviceId?: string;
  role?: 'device' | 'controller';
  sdp?: string;
  candidate?: IceCandidate;
}

interface Peer {
  ws: WebSocket;
  role: 'device' | 'controller';
  deviceId: string;
  /** Who authenticated: `device:<id>` for a device token, `controller:<subject>` for a ticket */
  principal: string;
}

/** Credential established during the HTTP upgrade (never taken from messages). */
type SignalingAuth =
  | { kind: 'controller'; subject: string; deviceId?: string }
  | { kind: 'device'; deviceId: string; token: string };

const upgradeAuth = new WeakMap<IncomingMessage, SignalingAuth>();
let signalingDb: Database.Database | null = null;

function database(): Database.Database {
  return signalingDb ?? getDatabase();
}

function authenticateSignalingUpgrade(request: IncomingMessage): SignalingAuth | null {
  const params = new URL(request.url || '', 'http://signaling.invalid').searchParams;
  const ticket = params.get('ticket');
  if (ticket) {
    const claims = wsTicketStore.consume(ticket, 'signaling');
    return claims ? { kind: 'controller', subject: claims.subject, deviceId: claims.deviceId } : null;
  }
  const header = request.headers['authorization'];
  const match = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  if (match) {
    const deviceId = validateSessionToken(database(), match[1]);
    return deviceId ? { kind: 'device', deviceId, token: match[1] } : null;
  }
  return null;
}

// Admin WebSocket types
interface AdminSubscription {
  ws: WebSocket;
  deviceIds: Set<string>;  // Empty = all devices
  eventTypes: Set<string>; // Empty = all events
  groupIds: Set<string>;   // Subscribe to group devices
}

interface AdminMessage {
  type: 'subscribe' | 'unsubscribe' | 'ping';
  deviceIds?: string[];
  eventTypes?: string[];
  groupIds?: string[];
}

// Room = deviceId -> { device?: Peer, controller?: Peer }
const rooms = new Map<string, { device?: Peer; controller?: Peer }>();

// Admin subscriptions
const adminConnections = new Map<WebSocket, AdminSubscription>();

// Subscribe to event store for broadcasting
let eventUnsubscribe: (() => void) | null = null;
let commandUnsubscribe: (() => void) | null = null;

function setupEventBroadcasting(): void {
  if (!eventUnsubscribe) {
    eventUnsubscribe = eventStore.subscribe((event: DeviceEvent) => {
      broadcastEventToAdmins(event);
    });
  }
  // Every command state change reaches the admin UI as { type: 'command-update', deviceId, command }
  if (!commandUnsubscribe) {
    commandUnsubscribe = commandStore.subscribe((command) => {
      for (const [ws, sub] of adminConnections) {
        if (sub.deviceIds.size > 0 && !sub.deviceIds.has(command.deviceId)) continue;
        send(ws, { type: 'command-update', deviceId: command.deviceId, command });
      }
    });
  }
}

function broadcastEventToAdmins(event: DeviceEvent): void {
  for (const [ws, sub] of adminConnections) {
    if (shouldReceiveEvent(sub, event)) {
      send(ws, {
        type: 'device-event',
        event: {
          id: event.id,
          deviceId: event.deviceId,
          eventType: event.eventType,
          severity: event.severity,
          data: event.data,
          createdAt: event.createdAt,
        },
      });
    }
  }
}

function shouldReceiveEvent(sub: AdminSubscription, event: DeviceEvent): boolean {
  // Check device filter
  if (sub.deviceIds.size > 0 && !sub.deviceIds.has(event.deviceId)) {
    return false;
  }

  // Check event type filter
  if (sub.eventTypes.size > 0 && !sub.eventTypes.has(event.eventType)) {
    return false;
  }

  return true;
}

function handleAdminMessage(ws: WebSocket, message: AdminMessage, subscription: AdminSubscription): void {
  switch (message.type) {
    case 'subscribe': {
      // Add device IDs to subscription
      if (message.deviceIds) {
        for (const id of message.deviceIds) {
          subscription.deviceIds.add(id);
        }
      }

      // Add event types to subscription
      if (message.eventTypes) {
        for (const type of message.eventTypes) {
          subscription.eventTypes.add(type);
        }
      }

      // Add group IDs to subscription
      if (message.groupIds) {
        for (const id of message.groupIds) {
          subscription.groupIds.add(id);
        }
      }

      send(ws, {
        type: 'subscribed',
        deviceIds: Array.from(subscription.deviceIds),
        eventTypes: Array.from(subscription.eventTypes),
        groupIds: Array.from(subscription.groupIds),
      });
      break;
    }

    case 'unsubscribe': {
      // Remove device IDs from subscription
      if (message.deviceIds) {
        for (const id of message.deviceIds) {
          subscription.deviceIds.delete(id);
        }
      }

      // Remove event types from subscription
      if (message.eventTypes) {
        for (const type of message.eventTypes) {
          subscription.eventTypes.delete(type);
        }
      }

      // Remove group IDs from subscription
      if (message.groupIds) {
        for (const id of message.groupIds) {
          subscription.groupIds.delete(id);
        }
      }

      send(ws, {
        type: 'unsubscribed',
        deviceIds: Array.from(subscription.deviceIds),
        eventTypes: Array.from(subscription.eventTypes),
        groupIds: Array.from(subscription.groupIds),
      });
      break;
    }

    case 'ping': {
      send(ws, { type: 'pong', timestamp: Date.now() });
      break;
    }

    default:
      send(ws, { type: 'error', message: `Unknown message type: ${(message as AdminMessage).type}` });
  }
}

const openServers: WebSocketServer[] = [];

/** Close every WebSocket server created by setupSignaling, and their clients (graceful shutdown, SR-13). */
export function closeAllWebSocketServers(): void {
  for (const wss of openServers.splice(0)) {
    for (const client of wss.clients) {
      try { client.close(1001, 'Server shutting down'); } catch { /* already closed */ }
    }
    wss.close();
  }
}

export function setupSignaling(server: Server, opts: { db?: Database.Database } = {}): WebSocketServer {
  signalingDb = opts.db ?? null;
  // Setup event broadcasting
  setupEventBroadcasting();

  // Use noServer mode to handle multiple WebSocket paths
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const adminWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const relayWss = createRelayWss({ db: opts.db });
  startPingSweep(wss);
  startPingSweep(adminWss);
  openServers.push(wss, adminWss, relayWss);
  server.on('close', () => {
    wss.close();
    adminWss.close();
  });

  // Authenticate during the HTTP upgrade, before any WebSocket exists (contracts C3, C4)
  server.on('upgrade', (request, socket, head) => {
    const pathname = (request.url || '').split('?')[0];

    if (pathname === '/ws') {
      const auth = authenticateSignalingUpgrade(request);
      if (!auth) return rejectUpgrade(socket, 401, 'Unauthorized');
      if (wss.clients.size >= envInt('WS_MAX_SIGNALING_CONNECTIONS', 500)) {
        return rejectUpgrade(socket, 503, 'Service Unavailable');
      }
      upgradeAuth.set(request, auth);
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else if (pathname === '/admin') {
      const params = new URL(request.url || '', 'http://admin.invalid').searchParams;
      const ticket = params.get('ticket');
      if (!ticket || !wsTicketStore.consume(ticket, 'admin')) return rejectUpgrade(socket, 401, 'Unauthorized');
      if (adminWss.clients.size >= envInt('WS_MAX_ADMIN_CONNECTIONS', 50)) {
        return rejectUpgrade(socket, 503, 'Service Unavailable');
      }
      adminWss.handleUpgrade(request, socket, head, (ws) => {
        adminWss.emit('connection', ws, request);
      });
    } else if (pathname === '/relay') {
      if (!authenticateRelayUpgrade(request)) return rejectUpgrade(socket, 401, 'Unauthorized');
      if (!relayCapacityAvailable()) return rejectUpgrade(socket, 503, 'Service Unavailable');
      relayWss.handleUpgrade(request, socket, head, (ws) => {
        relayWss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  adminWss.on('connection', (ws: WebSocket) => {
    // eslint-disable-next-line no-console
    console.log('[WS-Admin] New admin connection');

    const subscription: AdminSubscription = {
      ws,
      deviceIds: new Set(),
      eventTypes: new Set(),
      groupIds: new Set(),
    };
    adminConnections.set(ws, subscription);

    ws.on('message', (data: Buffer) => {
      try {
        const message: AdminMessage = JSON.parse(data.toString());
        handleAdminMessage(ws, message, subscription);
      } catch (e) {
        send(ws, { type: 'error', message: 'Invalid message format' });
      }
    });

    ws.on('close', () => {
      // eslint-disable-next-line no-console
      console.log('[WS-Admin] Admin disconnected');
      adminConnections.delete(ws);
    });

    ws.on('error', () => {
      adminConnections.delete(ws);
    });

    // Send initial connection confirmation
    send(ws, { type: 'connected', adminCount: adminConnections.size });
  });

  wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
    // eslint-disable-next-line no-console
    console.log('[WS] New WebSocket connection');
    const auth = upgradeAuth.get(request);
    upgradeAuth.delete(request);
    if (!auth) {
      ws.close(4401, 'unauthorized');
      return;
    }
    let currentPeer: Peer | null = null;

    ws.on('message', (data: Buffer) => {
      try {
        const message: SignalingMessage = JSON.parse(data.toString());
        handleMessage(ws, auth, message, currentPeer, (peer) => {
          currentPeer = peer;
        });
      } catch (e) {
        sendError(ws, 'Invalid message format');
      }
    });

    ws.on('close', () => {
      if (currentPeer) {
        handleDisconnect(currentPeer);
      }
    });

    ws.on('error', () => {
      if (currentPeer) {
        handleDisconnect(currentPeer);
      }
    });
  });

  return wss;
}

function handleMessage(
  ws: WebSocket,
  auth: SignalingAuth,
  message: SignalingMessage,
  currentPeer: Peer | null,
  setPeer: (peer: Peer) => void
): void {
  switch (message.type) {
    case 'join': {
      if (!message.deviceId || typeof message.deviceId !== 'string') {
        sendError(ws, 'Missing deviceId');
        return;
      }
      if (currentPeer) {
        sendError(ws, 'Already joined a room');
        return;
      }

      const { deviceId } = message;
      // The role comes from the credential; whatever the message claims is ignored (contract C4)
      const role: 'device' | 'controller' = auth.kind === 'device' ? 'device' : 'controller';
      const authorized =
        auth.kind === 'device'
          ? auth.deviceId === deviceId && validateSessionToken(database(), auth.token, deviceId) !== null
          : auth.deviceId === undefined || auth.deviceId === deviceId;
      if (!authorized) {
        sendError(ws, 'Not authorized for this device');
        return;
      }
      const principal = auth.kind === 'device' ? `device:${auth.deviceId}` : `controller:${auth.subject}`;
      // eslint-disable-next-line no-console
      console.log(`[WS] Join: deviceId=${deviceId}, role=${role}`);
      let room = rooms.get(deviceId);

      if (!room) {
        room = {};
        rooms.set(deviceId, room);
      }

      // A role can only be taken over by the same authenticated principal (or when the old socket is dead)
      const existingPeer = room[role];
      if (existingPeer && existingPeer.ws !== ws) {
        const dead = existingPeer.ws.readyState !== WebSocket.OPEN;
        if (existingPeer.principal !== principal && !dead) {
          sendError(ws, `Role ${role} already taken in this room`);
          return;
        }
        // eslint-disable-next-line no-console
        console.log(`[WS] Replacing stale ${role} in room ${deviceId}`);
        // The slot is reassigned below; the old socket's late close finds it no longer owns the slot
        delete room[role];
        existingPeer.ws.close(1000, 'Replaced by new connection');
      }

      const peer: Peer = { ws, role, deviceId, principal };
      room[role] = peer;
      setPeer(peer);

      // Notify the other peer if present
      const otherRole = role === 'device' ? 'controller' : 'device';
      const otherPeer = room[otherRole];
      if (otherPeer) {
        // eslint-disable-next-line no-console
        console.log(`[WS] Notifying ${otherRole} that ${role} joined`);
        send(otherPeer.ws, { type: 'peer-joined', role });
        send(ws, { type: 'peer-joined', role: otherRole });
      } else {
        // eslint-disable-next-line no-console
        console.log(`[WS] No ${otherRole} peer in room yet`);
      }
      break;
    }

    case 'offer':
    case 'answer':
    case 'ice-candidate': {
      // eslint-disable-next-line no-console
      console.log(`[WS] ${message.type} from ${currentPeer?.role || 'unknown'}`);
      if (!currentPeer) {
        sendError(ws, 'Must join a room first');
        return;
      }

      const room = rooms.get(currentPeer.deviceId);
      if (!room) return;

      // Relay to the other peer
      const otherRole = currentPeer.role === 'device' ? 'controller' : 'device';
      const otherPeer = room[otherRole];

      if (otherPeer) {
        // eslint-disable-next-line no-console
        console.log(`[WS] Forwarding ${message.type} to ${otherRole}`);
        send(otherPeer.ws, message);
      } else {
        // eslint-disable-next-line no-console
        console.log(`[WS] No ${otherRole} peer to forward ${message.type} to`);
      }
      break;
    }

    default:
      sendError(ws, `Unknown message type: ${(message as SignalingMessage).type}`);
  }
}

function handleDisconnect(peer: Peer): void {
  const room = rooms.get(peer.deviceId);
  if (!room) return;

  // A replaced peer no longer owns the slot: its late close must not notify anyone (SR-07)
  if (room[peer.role] !== peer) return;
  delete room[peer.role];

  // Notify other peer
  const otherRole = peer.role === 'device' ? 'controller' : 'device';
  const otherPeer = room[otherRole];
  if (otherPeer) {
    send(otherPeer.ws, { type: 'peer-left' });
  }

  // Clean up empty rooms
  if (!room.device && !room.controller) {
    rooms.delete(peer.deviceId);
  }
}

function send(ws: WebSocket, message: object): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function sendError(ws: WebSocket, message: string): void {
  send(ws, { type: 'error', message });
}

/**
 * Revoke a device's live connections now: its signaling peers (device and controller), the relay agent and
 * relay viewers. The caller has already removed the device's sessions. Returns the number of sockets closed.
 */
export function disconnectDevice(deviceId: string, reason: string): number {
  let closed = 0;
  const room = rooms.get(deviceId);
  rooms.delete(deviceId);
  if (room) {
    for (const peer of [room.device, room.controller]) {
      if (!peer) continue;
      try { peer.ws.close(4004, reason); closed++; } catch { /* ignore */ }
    }
  }
  if (disconnectRelayDevice(deviceId, reason)) closed++;
  return closed;
}

// For testing
export function clearRooms(): void {
  rooms.clear();
}

export function getRoomCount(): number {
  return rooms.size;
}
