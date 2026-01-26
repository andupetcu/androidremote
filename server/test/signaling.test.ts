import { createServer, Server } from 'http';
import WebSocket from 'ws';
import { setupSignaling, clearRooms, getRoomCount } from '../src/signaling';

describe('Signaling Server', () => {
  let server: Server;
  let port: number;

  beforeEach((done) => {
    clearRooms();
    server = createServer();
    setupSignaling(server);
    server.listen(0, () => {
      const addr = server.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      done();
    });
  });

  afterEach((done) => {
    server.close(done);
  });

  function connect(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
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
      const ws = await connect();

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
        message: 'Missing deviceId or role',
      });

      ws.close();
    });

    it('rejects join without role', async () => {
      const ws = await connect();
      const messagePromise = waitForMessage(ws);

      ws.send(JSON.stringify({
        type: 'join',
        deviceId: 'test-device',
      }));

      const response = await messagePromise;
      expect(response).toEqual({
        type: 'error',
        message: 'Missing deviceId or role',
      });

      ws.close();
    });

    it('rejects duplicate role in same room', async () => {
      const ws1 = await connect();
      const ws2 = await connect();

      ws1.send(JSON.stringify({
        type: 'join',
        deviceId: 'test-device',
        role: 'device',
      }));

      // Small delay to ensure first join processes
      await new Promise((r) => setTimeout(r, 50));

      const messagePromise = waitForMessage(ws2);
      ws2.send(JSON.stringify({
        type: 'join',
        deviceId: 'test-device',
        role: 'device',
      }));

      const response = await messagePromise;
      expect(response).toEqual({
        type: 'error',
        message: 'Role device already taken in this room',
      });

      ws1.close();
      ws2.close();
    });
  });

  describe('Peer Notifications', () => {
    it('notifies when second peer joins', async () => {
      const device = await connect();
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
      const device = await connect();
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
      const device = await connect();
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
      const device = await connect();
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
      const device = await connect();
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
      const device = await connect();
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
