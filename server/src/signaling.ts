import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { eventStore, DeviceEvent } from './services/eventStore';
import { deviceStore } from './services/deviceStore';

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

function setupEventBroadcasting(): void {
  if (eventUnsubscribe) return;

  eventUnsubscribe = eventStore.subscribe((event: DeviceEvent) => {
    broadcastEventToAdmins(event);
  });
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

export function setupSignaling(server: Server): WebSocketServer {
  // Setup event broadcasting
  setupEventBroadcasting();

  // Use noServer mode to handle multiple WebSocket paths
  const wss = new WebSocketServer({ noServer: true });
  const adminWss = new WebSocketServer({ noServer: true });

  // Handle HTTP upgrade requests manually
  server.on('upgrade', (request, socket, head) => {
    const pathname = request.url || '';

    if (pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else if (pathname === '/admin') {
      adminWss.handleUpgrade(request, socket, head, (ws) => {
        adminWss.emit('connection', ws, request);
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

  wss.on('connection', (ws: WebSocket) => {
    // eslint-disable-next-line no-console
    console.log('[WS] New WebSocket connection');
    let currentPeer: Peer | null = null;

    ws.on('message', (data: Buffer) => {
      try {
        const message: SignalingMessage = JSON.parse(data.toString());
        handleMessage(ws, message, currentPeer, (peer) => {
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
  message: SignalingMessage,
  currentPeer: Peer | null,
  setPeer: (peer: Peer) => void
): void {
  switch (message.type) {
    case 'join': {
      if (!message.deviceId || !message.role) {
        sendError(ws, 'Missing deviceId or role');
        return;
      }

      const { deviceId, role } = message;
      // eslint-disable-next-line no-console
      console.log(`[WS] Join: deviceId=${deviceId}, role=${role}`);
      let room = rooms.get(deviceId);

      if (!room) {
        room = {};
        rooms.set(deviceId, room);
      }

      // Check if role already taken
      if (room[role]) {
        sendError(ws, `Role ${role} already taken in this room`);
        return;
      }

      const peer: Peer = { ws, role, deviceId };
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

  // Remove peer from room
  if (room[peer.role] === peer) {
    delete room[peer.role];
  }

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

// For testing
export function clearRooms(): void {
  rooms.clear();
}

export function getRoomCount(): number {
  return rooms.size;
}
