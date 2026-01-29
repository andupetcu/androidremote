import { useState, useEffect, useCallback, useRef } from 'react';
import type { DeviceEvent, Device } from '../types/api';

const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_BASE = import.meta.env.DEV ? 'ws://localhost:7899' : `${WS_PROTOCOL}//${window.location.host}`;

type AdminEventType =
  | 'device-online'
  | 'device-offline'
  | 'device-enrolled'
  | 'device-unenrolled'
  | 'event-created'
  | 'command-status'
  | 'telemetry-updated';

interface AdminMessage {
  type: AdminEventType;
  deviceId?: string;
  device?: Device;
  event?: DeviceEvent;
  data?: Record<string, unknown>;
  timestamp: number;
}

type MessageHandler = (message: AdminMessage) => void;

interface UseAdminWebSocketResult {
  connected: boolean;
  lastMessage: AdminMessage | null;
  subscribe: (eventType: AdminEventType, handler: MessageHandler) => () => void;
  subscribeAll: (handler: MessageHandler) => () => void;
}

export function useAdminWebSocket(): UseAdminWebSocketResult {
  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<AdminMessage | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Map<AdminEventType | '*', Set<MessageHandler>>>(new Map());
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(`${WS_BASE}/admin`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      console.log('[AdminWS] Connected');
    };

    ws.onclose = () => {
      setConnected(false);
      console.log('[AdminWS] Disconnected, reconnecting in 5s...');
      reconnectTimeoutRef.current = setTimeout(connect, 5000);
    };

    ws.onerror = (error) => {
      console.error('[AdminWS] Error:', error);
    };

    ws.onmessage = (event) => {
      try {
        const message: AdminMessage = JSON.parse(event.data);
        setLastMessage(message);

        // Notify type-specific handlers
        const typeHandlers = handlersRef.current.get(message.type);
        if (typeHandlers) {
          typeHandlers.forEach((handler) => handler(message));
        }

        // Notify wildcard handlers
        const allHandlers = handlersRef.current.get('*');
        if (allHandlers) {
          allHandlers.forEach((handler) => handler(message));
        }
      } catch (err) {
        console.error('[AdminWS] Failed to parse message:', err);
      }
    };
  }, []);

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      wsRef.current?.close();
    };
  }, [connect]);

  const subscribe = useCallback((eventType: AdminEventType, handler: MessageHandler) => {
    if (!handlersRef.current.has(eventType)) {
      handlersRef.current.set(eventType, new Set());
    }
    handlersRef.current.get(eventType)!.add(handler);

    // Return unsubscribe function
    return () => {
      handlersRef.current.get(eventType)?.delete(handler);
    };
  }, []);

  const subscribeAll = useCallback((handler: MessageHandler) => {
    if (!handlersRef.current.has('*')) {
      handlersRef.current.set('*', new Set());
    }
    handlersRef.current.get('*')!.add(handler);

    return () => {
      handlersRef.current.get('*')?.delete(handler);
    };
  }, []);

  return { connected, lastMessage, subscribe, subscribeAll };
}

// Hook for subscribing to specific event types with automatic cleanup
export function useAdminEvent(
  eventType: AdminEventType,
  handler: MessageHandler,
  deps: React.DependencyList = []
): { connected: boolean } {
  const { connected, subscribe } = useAdminWebSocket();

  useEffect(() => {
    const unsubscribe = subscribe(eventType, handler);
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, eventType, ...deps]);

  return { connected };
}

// Hook for real-time device status updates
export function useRealtimeDeviceStatus(
  onDeviceOnline?: (deviceId: string, device?: Device) => void,
  onDeviceOffline?: (deviceId: string) => void
): { connected: boolean } {
  const { connected, subscribe } = useAdminWebSocket();

  useEffect(() => {
    const unsubOnline = subscribe('device-online', (msg) => {
      if (msg.deviceId && onDeviceOnline) {
        onDeviceOnline(msg.deviceId, msg.device);
      }
    });

    const unsubOffline = subscribe('device-offline', (msg) => {
      if (msg.deviceId && onDeviceOffline) {
        onDeviceOffline(msg.deviceId);
      }
    });

    return () => {
      unsubOnline();
      unsubOffline();
    };
  }, [subscribe, onDeviceOnline, onDeviceOffline]);

  return { connected };
}

// Hook for real-time events feed
export function useRealtimeEvents(
  onEvent: (event: DeviceEvent) => void
): { connected: boolean } {
  const { connected, subscribe } = useAdminWebSocket();

  useEffect(() => {
    const unsub = subscribe('event-created', (msg) => {
      if (msg.event) {
        onEvent(msg.event);
      }
    });

    return unsub;
  }, [subscribe, onEvent]);

  return { connected };
}
