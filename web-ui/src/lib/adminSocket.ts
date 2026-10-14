import { fetchWsTicket, buildWsUrl } from './wsTicket';
import type { DeviceEvent, Device, DeviceCommand } from '../types/api';

/**
 * Message types the server sends on /admin (see server/src/signaling.ts).
 * Live device events all arrive as 'device-event' with event.eventType set.
 */
export const ADMIN_MESSAGE_TYPES = [
  'connected',
  'device-event',
  'command-update',
  'subscribed',
  'unsubscribed',
  'pong',
  'error',
] as const;
export type AdminMessageType = (typeof ADMIN_MESSAGE_TYPES)[number];

export interface AdminMessage {
  type: AdminMessageType;
  deviceId?: string;
  device?: Device;
  event?: DeviceEvent;
  /** 'command-update': a command changed state (every transition, not only the final one). */
  command?: DeviceCommand;
  message?: string;
}

export type AdminMessageHandler = (message: AdminMessage) => void;

const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_BASE = import.meta.env.DEV ? 'ws://localhost:7899' : `${WS_PROTOCOL}//${window.location.host}`;
const RECONNECT_MS = 5000;

// Module singleton: one /admin socket for the whole app.
let generation = 0; // bumped by closeAdminSocket so stale async work is ignored
let refCount = 0;
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let connecting = false;
let connected = false;
const handlers = new Map<AdminMessageType | '*', Set<AdminMessageHandler>>();
const statusListeners = new Set<(connected: boolean) => void>();

function setConnected(value: boolean) {
  if (connected === value) return;
  connected = value;
  statusListeners.forEach((l) => l(value));
}

function active(gen: number): boolean {
  return gen === generation && refCount > 0;
}

async function connect(gen: number): Promise<void> {
  if (connecting || ws || !active(gen)) return;
  connecting = true;
  try {
    // A ticket is single use, so every (re)connect fetches a fresh one.
    const ticket = await fetchWsTicket('admin');
    if (!active(gen)) return;
    const socket = new WebSocket(buildWsUrl(`${WS_BASE}/admin`, ticket));
    ws = socket;
    socket.onopen = () => {
      if (ws === socket) setConnected(true);
    };
    socket.onmessage = (ev) => {
      if (ws !== socket) return;
      let msg: AdminMessage;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      handlers.get(msg.type)?.forEach((h) => h(msg));
      handlers.get('*')?.forEach((h) => h(msg));
    };
    socket.onerror = () => {};
    socket.onclose = () => {
      if (ws !== socket) return; // closed deliberately and already replaced
      ws = null;
      setConnected(false);
      scheduleReconnect(gen);
    };
  } catch {
    scheduleReconnect(gen);
  } finally {
    connecting = false;
  }
}

function scheduleReconnect(gen: number) {
  if (!active(gen) || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect(gen);
  }, RECONNECT_MS);
}

function teardown() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const socket = ws;
  ws = null; // detach first so onclose cannot schedule a reconnect
  socket?.close(1000, 'client closing');
  setConnected(false);
}

/** Take a reference to the shared socket. Returns an idempotent release function. */
export function acquireAdminSocket(): () => void {
  const gen = generation;
  refCount += 1;
  if (refCount === 1) void connect(gen);
  let released = false;
  return () => {
    if (released || gen !== generation) return;
    released = true;
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0) teardown();
  };
}

/** Logout: close the socket for good and drop every handler. */
export function closeAdminSocket(): void {
  generation += 1;
  refCount = 0;
  connecting = false;
  handlers.clear();
  teardown();
}

export function addAdminHandler(type: AdminMessageType | '*', handler: AdminMessageHandler): () => void {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type)!.add(handler);
  return () => {
    handlers.get(type)?.delete(handler);
  };
}

export function onAdminStatus(listener: (connected: boolean) => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

export function isAdminConnected(): boolean {
  return connected;
}
