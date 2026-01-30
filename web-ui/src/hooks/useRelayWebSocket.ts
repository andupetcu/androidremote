import { useCallback, useEffect, useRef, useState } from 'react';
import * as Protocol from '../lib/BinaryProtocol';

export type RelayConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

export interface UseRelayWebSocketOptions {
  /** Device ID to connect to */
  deviceId: string;
  /** Session type */
  sessionType: 'desktop' | 'terminal' | 'files';
  /** Auth token (JWT) */
  token: string;
  /** Auto-connect on mount */
  autoConnect?: boolean;
  /** Handler for received protocol messages */
  onMessage?: (msg: Protocol.ProtocolMessage) => void;
  /** Handler for connection state changes */
  onStateChange?: (state: RelayConnectionState) => void;
  /** Handler for errors */
  onError?: (error: string) => void;
}

export interface UseRelayWebSocketReturn {
  /** Current connection state */
  state: RelayConnectionState;
  /** Channel ID assigned by server */
  channelId: number | null;
  /** Connect to the relay */
  connect: () => void;
  /** Disconnect from the relay */
  disconnect: () => void;
  /** Send a binary protocol message */
  send: (data: ArrayBuffer) => void;
  /** Send raw bytes as terminal data */
  sendTerminalData: (data: Uint8Array | string) => void;
  /** Send terminal resize */
  sendTerminalResize: (cols: number, rows: number) => void;
}

function getRelayUrl(
  deviceId: string,
  sessionType: string,
  token: string
): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/relay?deviceId=${encodeURIComponent(deviceId)}&session=${sessionType}&token=${encodeURIComponent(token)}`;
}

export function useRelayWebSocket(
  options: UseRelayWebSocketOptions
): UseRelayWebSocketReturn {
  const { deviceId, sessionType, token, autoConnect, onMessage, onStateChange, onError } =
    options;

  const [state, setState] = useState<RelayConnectionState>('disconnected');
  const [channelId, setChannelId] = useState<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const readBufferRef = useRef<Uint8Array>(new Uint8Array(0));

  // Keep callbacks in refs to avoid reconnection on callback changes
  const onMessageRef = useRef(onMessage);
  const onStateChangeRef = useRef(onStateChange);
  const onErrorRef = useRef(onError);
  onMessageRef.current = onMessage;
  onStateChangeRef.current = onStateChange;
  onErrorRef.current = onError;

  const updateState = useCallback((newState: RelayConnectionState) => {
    setState(newState);
    onStateChangeRef.current?.(newState);
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    updateState('connecting');
    readBufferRef.current = new Uint8Array(0);

    const url = getRelayUrl(deviceId, sessionType, token);
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      console.log(`[Relay] Connected to ${sessionType} for device ${deviceId}`);
      updateState('connected');
    };

    ws.onmessage = (event: MessageEvent) => {
      if (!(event.data instanceof ArrayBuffer)) return;

      const incoming = new Uint8Array(event.data);

      // Append to read buffer
      const prev = readBufferRef.current;
      const combined = new Uint8Array(prev.length + incoming.length);
      combined.set(prev);
      combined.set(incoming, prev.length);

      // Decode all complete messages
      const { messages, remaining } = Protocol.decodeAll(combined);
      readBufferRef.current = remaining;

      for (const msg of messages) {
        // Extract channel from first message (server assigns it)
        if (channelId === null && msg.header.channel > 0) {
          setChannelId(msg.header.channel);
        }

        // Handle heartbeats internally
        if (msg.header.type === Protocol.HEARTBEAT) {
          const ack = Protocol.encode(Protocol.HEARTBEAT_ACK, 0, 0, new Uint8Array(0));
          ws.send(ack);
          continue;
        }

        onMessageRef.current?.(msg);
      }
    };

    ws.onclose = (event) => {
      console.log(`[Relay] Disconnected: code=${event.code} reason=${event.reason}`);
      updateState('disconnected');
      setChannelId(null);
      wsRef.current = null;
    };

    ws.onerror = () => {
      console.error('[Relay] WebSocket error');
      onErrorRef.current?.('WebSocket connection error');
      updateState('error');
    };
  }, [deviceId, sessionType, token, updateState, channelId]);

  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close(1000, 'user disconnect');
      wsRef.current = null;
    }
    updateState('disconnected');
    setChannelId(null);
  }, [updateState]);

  const send = useCallback((data: ArrayBuffer) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    }
  }, []);

  const sendTerminalData = useCallback(
    (data: Uint8Array | string) => {
      const ch = channelId ?? 1;
      const msg = Protocol.encodeTerminalData(ch, data);
      send(msg);
    },
    [send, channelId]
  );

  const sendTerminalResize = useCallback(
    (cols: number, rows: number) => {
      const ch = channelId ?? 1;
      const msg = Protocol.encodeTerminalResize(ch, cols, rows);
      send(msg);
    },
    [send, channelId]
  );

  // Auto-connect
  useEffect(() => {
    if (autoConnect && token) {
      connect();
    }
    return () => {
      if (wsRef.current) {
        wsRef.current.close(1000, 'component unmount');
        wsRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConnect, token]);

  return {
    state,
    channelId,
    connect,
    disconnect,
    send,
    sendTerminalData,
    sendTerminalResize,
  };
}
