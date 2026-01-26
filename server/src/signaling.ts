import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';

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

// Room = deviceId -> { device?: Peer, controller?: Peer }
const rooms = new Map<string, { device?: Peer; controller?: Peer }>();

export function setupSignaling(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket) => {
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
        send(otherPeer.ws, { type: 'peer-joined', role });
        send(ws, { type: 'peer-joined', role: otherRole });
      }
      break;
    }

    case 'offer':
    case 'answer':
    case 'ice-candidate': {
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
        send(otherPeer.ws, message);
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
