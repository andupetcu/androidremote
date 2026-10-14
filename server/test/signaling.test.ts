import { createServer, Server } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { setupSignaling, clearRooms, getRoomCount } from '../src/signaling';
import { shutdownRelay } from '../src/relay';
import { wsTicketStore } from '../src/services/wsTicketStore';
import { setupTestDatabase, cleanupTestDatabase, closeTestDatabase } from './setup';

describe('Signaling Server', () => {
  let server: Server;
  let wss: WebSocketServer;
  let port: number;
  // Every client socket opened by a test, so teardown can close them all
  let sockets: WebSocket[] = [];

  const DEVICE_TOKEN = 'a'.repeat(32);
  let db: ReturnType<typeof setupTestDatabase>;

  beforeAll(() => {
    db = setupTestDatabase();
  });
  afterAll(() => closeTestDatabase());

  beforeEach((done) => {
    clearRooms();
    sockets = [];
    db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('test-device', 'test-device');
    db.prepare('INSERT INTO sessions (token, device_id, expires_at) VALUES (?, ?, ?)')
      .run(DEVICE_TOKEN, 'test-device', Date.now() + 3_600_000);
    server = createServer();
    wss = setupSignaling(server, { db });
    server.listen(0, () => {
      const addr = server.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      done();
    });
  });

  afterEach((done) => {
    // Terminate client sockets first: server.close() waits for them, which is what hung jest
    for (const ws of sockets) {
      ws.terminate();
    }
    sockets = [];
    wss.close();
    // setupSignaling starts the relay's stale-check interval; stop it or jest cannot exit
    shutdownRelay();
    cleanupTestDatabase();
    server.close(done);
  });

  // Authenticated connect: devices present their session token, controllers a signaling ticket
  function connect(role: 'device' | 'controller' = 'controller'): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = role === 'device'
        ? new WebSocket(`ws://localhost:${port}/ws`, { headers: { Authorization: `Bearer ${DEVICE_TOKEN}` } })
        : new WebSocket(`ws://localhost:${port}/ws?ticket=${wsTicketStore.issue({ purpose: 'signaling', subject: 'admin' }).ticket}`);
      sockets.push(ws);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  }

  function waitForMessage(ws: WebSocket): Promise<unknown> {
    return new Promise((resolve) => {
      ws.once('message', (data) => {
        resolve(JSON.parse(data.toString()));
      });
    });
  }

  describe('Join', () => {
    it('accepts device join', async () => {
      const ws = await connect('device');

      ws.send(JSON.stringify({
        type: 'join',
        deviceId: 'test-device',
        role: 'device',
      }));

      // Wait for message to be processed
      await new Promise((r) => setTimeout(r, 50));
      expect(getRoomCount()).toBe(1);

      ws.close();
    });

    it('accepts controller join', async () => {
      const ws = await connect();

      ws.send(JSON.stringify({
        type: 'join',
        deviceId: 'test-device',
        role: 'controller',
      }));

      // Wait for message to be processed
      await new Promise((r) => setTimeout(r, 50));
      expect(getRoomCount()).toBe(1);

      ws.close();
    });

    it('rejects join without deviceId', async () => {
      const ws = await connect();
      const messagePromise = waitForMessage(ws);

      ws.send(JSON.stringify({
        type: 'join',
        role: 'device',
      }));

      const response = await messagePromise;
      expect(response).toEqual({
        type: 'error',
        message: 'Missing deviceId',
      });

      ws.close();
    });

    it('does not need a role in the message: it comes from the credential', async () => {
      const ws = await connect();

      ws.send(JSON.stringify({
        type: 'join',
        deviceId: 'test-device',
      }));

      await new Promise((r) => setTimeout(r, 50));
      expect(getRoomCount()).toBe(1);

      ws.close();
    });

    // C4: a different principal can never take over an occupied role (formerly KNOWN-BUG, SR-07/SS-02)
    it('rejects duplicate role in same room', async () => {
      const ws1 = await connect();
      const ws2 = await new Promise<WebSocket>((resolve, reject) => {
        const ticket = wsTicketStore.issue({ purpose: 'signaling', subject: 'someone-else' }).ticket;
        const ws = new WebSocket(`ws://localhost:${port}/ws?ticket=${ticket}`);
        sockets.push(ws);
        ws.on('open', () => resolve(ws));
        ws.on('error', reject);
      });

      ws1.send(JSON.stringify({
        type: 'join',
        deviceId: 'test-device',
      }));

      // Small delay to ensure first join processes
      await new Promise((r) => setTimeout(r, 50));

      const messagePromise = waitForMessage(ws2);
      ws2.send(JSON.stringify({
        type: 'join',
        deviceId: 'test-device',
      }));

      const response = await messagePromise;
      expect(response).toEqual({
        type: 'error',
        message: 'Role controller already taken in this room',
      });

      ws1.close();
      ws2.close();
    });
  });

  describe('Peer Notifications', () => {
    it('notifies when second peer joins', async () => {
      const device = await connect('device');
      const controller = await connect();

      device.send(JSON.stringify({
        type: 'join',
        deviceId: 'test-device',
        role: 'device',
      }));

      await new Promise((r) => setTimeout(r, 50));

      const deviceNotification = waitForMessage(device);
      const controllerNotification = waitForMessage(controller);

      controller.send(JSON.stringify({
        type: 'join',
        deviceId: 'test-device',
        role: 'controller',
      }));

      const [deviceMsg, controllerMsg] = await Promise.all([
        deviceNotification,
        controllerNotification,
      ]);

      expect(deviceMsg).toEqual({ type: 'peer-joined', role: 'controller' });
      expect(controllerMsg).toEqual({ type: 'peer-joined', role: 'device' });

      device.close();
      controller.close();
    });

    it('notifies when peer disconnects', async () => {
      const device = await connect('device');
      const controller = await connect();

      device.send(JSON.stringify({
        type: 'join',
        deviceId: 'test-device',
        role: 'device',
      }));

      await new Promise((r) => setTimeout(r, 50));

      controller.send(JSON.stringify({
        type: 'join',
        deviceId: 'test-device',
        role: 'controller',
      }));

      await new Promise((r) => setTimeout(r, 50));

      const notification = waitForMessage(device);
      controller.close();

      const msg = await notification;
      expect(msg).toEqual({ type: 'peer-left' });

      device.close();
    });
  });

  describe('Message Relay', () => {
    it('relays offer from controller to device', async () => {
      const device = await connect('device');
      const controller = await connect();

      device.send(JSON.stringify({
        type: 'join',
        deviceId: 'test-device',
        role: 'device',
      }));

      await new Promise((r) => setTimeout(r, 50));

      controller.send(JSON.stringify({
        type: 'join',
        deviceId: 'test-device',
        role: 'controller',
      }));

      // Skip peer-joined notifications
      await waitForMessage(device);
      await waitForMessage(controller);

      const offerPromise = waitForMessage(device);

      controller.send(JSON.stringify({
        type: 'offer',
        sdp: 'v=0\r\n...',
      }));

      const received = await offerPromise;
      expect(received).toEqual({
        type: 'offer',
        sdp: 'v=0\r\n...',
      });

      device.close();
      controller.close();
    });

    it('relays answer from device to controller', async () => {
      const device = await connect('device');
      const controller = await connect();

      device.send(JSON.stringify({
        type: 'join',
        deviceId: 'test-device',
        role: 'device',
      }));

      await new Promise((r) => setTimeout(r, 50));

      controller.send(JSON.stringify({
        type: 'join',
        deviceId: 'test-device',
        role: 'controller',
      }));

      await waitForMessage(device);
      await waitForMessage(controller);

      const answerPromise = waitForMessage(controller);

      device.send(JSON.stringify({
        type: 'answer',
        sdp: 'v=0\r\n...',
      }));

      const received = await answerPromise;
      expect(received).toEqual({
        type: 'answer',
        sdp: 'v=0\r\n...',
      });

      device.close();
      controller.close();
    });

    it('relays ICE candidates', async () => {
      const device = await connect('device');
      const controller = await connect();

      device.send(JSON.stringify({
        type: 'join',
        deviceId: 'test-device',
        role: 'device',
      }));

      await new Promise((r) => setTimeout(r, 50));

      controller.send(JSON.stringify({
        type: 'join',
        deviceId: 'test-device',
        role: 'controller',
      }));

      await waitForMessage(device);
      await waitForMessage(controller);

      const icePromise = waitForMessage(device);

      controller.send(JSON.stringify({
        type: 'ice-candidate',
        candidate: {
          candidate: 'candidate:1 1 UDP 2122252543 192.168.1.100 52000 typ host',
          sdpMid: '0',
          sdpMLineIndex: 0,
        },
      }));

      const received = await icePromise;
      expect(received).toEqual({
        type: 'ice-candidate',
        candidate: {
          candidate: 'candidate:1 1 UDP 2122252543 192.168.1.100 52000 typ host',
          sdpMid: '0',
          sdpMLineIndex: 0,
        },
      });

      device.close();
      controller.close();
    });

    it('rejects relay before joining room', async () => {
      const ws = await connect();
      const messagePromise = waitForMessage(ws);

      ws.send(JSON.stringify({
        type: 'offer',
        sdp: 'v=0\r\n...',
      }));

      const response = await messagePromise;
      expect(response).toEqual({
        type: 'error',
        message: 'Must join a room first',
      });

      ws.close();
    });
  });

  describe('Room Cleanup', () => {
    it('removes empty rooms when all peers disconnect', async () => {
      const device = await connect('device');
      const controller = await connect();

      device.send(JSON.stringify({
        type: 'join',
        deviceId: 'test-device',
        role: 'device',
      }));

      await new Promise((r) => setTimeout(r, 50));

      controller.send(JSON.stringify({
        type: 'join',
        deviceId: 'test-device',
        role: 'controller',
      }));

      await new Promise((r) => setTimeout(r, 50));
      expect(getRoomCount()).toBe(1);

      device.close();
      await new Promise((r) => setTimeout(r, 50));
      expect(getRoomCount()).toBe(1); // Controller still present

      controller.close();
      await new Promise((r) => setTimeout(r, 50));
      expect(getRoomCount()).toBe(0); // Room cleaned up
    });
  });

  describe('Error Handling', () => {
    it('handles invalid JSON gracefully', async () => {
      const ws = await connect();
      const messagePromise = waitForMessage(ws);

      ws.send('not valid json');

      const response = await messagePromise;
      expect(response).toEqual({
        type: 'error',
        message: 'Invalid message format',
      });

      ws.close();
    });
  });
});
