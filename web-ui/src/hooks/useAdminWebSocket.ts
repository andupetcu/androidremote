import { useState, useEffect, useCallback } from 'react';
import type { DeviceEvent, Device } from '../types/api';
import {
  acquireAdminSocket,
  addAdminHandler,
  onAdminStatus,
  isAdminConnected,
  type AdminMessage,
  type AdminMessageType,
} from '../lib/adminSocket';

export type { AdminMessage };
type AdminEventType = AdminMessageType;
type MessageHandler = (message: AdminMessage) => void;

interface UseAdminWebSocketResult {
  connected: boolean;
  lastMessage: AdminMessage | null;
  subscribe: (eventType: AdminEventType, handler: MessageHandler) => () => void;
  subscribeAll: (handler: MessageHandler) => () => void;
}

/** All hooks share ONE socket (lib/adminSocket); it closes when the last user unmounts. */
export function useAdminWebSocket(): UseAdminWebSocketResult {
  const [connected, setConnected] = useState(isAdminConnected());
  const [lastMessage, setLastMessage] = useState<AdminMessage | null>(null);

  useEffect(() => {
    const release = acquireAdminSocket();
    const offStatus = onAdminStatus(setConnected);
    const offMessages = addAdminHandler('*', setLastMessage);
    return () => {
      offMessages();
      offStatus();
      release();
    };
  }, []);

  const subscribe = useCallback(
    (eventType: AdminEventType, handler: MessageHandler) => addAdminHandler(eventType, handler),
    []
  );
  const subscribeAll = useCallback((handler: MessageHandler) => addAdminHandler('*', handler), []);

  return { connected, lastMessage, subscribe, subscribeAll };
}

// Hook for subscribing to specific message types with automatic cleanup
export function useAdminEvent(
  eventType: AdminEventType,
  handler: MessageHandler,
  deps: React.DependencyList = []
): { connected: boolean } {
  const { connected, subscribe } = useAdminWebSocket();

  useEffect(() => {
    return subscribe(eventType, handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, eventType, ...deps]);

  return { connected };
}

// Real-time device status: derived from 'device-event' messages by eventType.
export function useRealtimeDeviceStatus(
  onDeviceOnline?: (deviceId: string, device?: Device) => void,
  onDeviceOffline?: (deviceId: string) => void
): { connected: boolean } {
  const { connected, subscribe } = useAdminWebSocket();

  useEffect(() => {
    return subscribe('device-event', (msg) => {
      const event = msg.event;
      if (!event) return;
      if (event.eventType === 'device-online') onDeviceOnline?.(event.deviceId, msg.device);
      else if (event.eventType === 'device-offline') onDeviceOffline?.(event.deviceId);
    });
  }, [subscribe, onDeviceOnline, onDeviceOffline]);

  return { connected };
}

// Real-time events feed
export function useRealtimeEvents(onEvent: (event: DeviceEvent) => void): { connected: boolean } {
  const { connected, subscribe } = useAdminWebSocket();

  useEffect(() => {
    return subscribe('device-event', (msg) => {
      if (msg.event) onEvent(msg.event);
    });
  }, [subscribe, onEvent]);

  return { connected };
}
