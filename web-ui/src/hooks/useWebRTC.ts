import { fetchWsTicket, buildWsUrl } from '../lib/wsTicket';
import { apiFetch, API_BASE } from '../utils/api';
import { useState, useEffect, useRef, useCallback } from 'react';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'failed';

/**
 * Command types matching Android's RemoteCommand sealed class.
 */
export type RemoteCommand =
  // Input commands
  | { type: 'TAP'; x: number; y: number }
  | { type: 'SWIPE'; startX: number; startY: number; endX: number; endY: number; durationMs?: number }
  | { type: 'LONG_PRESS'; x: number; y: number; durationMs?: number }
  | { type: 'KEY_PRESS'; keyCode: number }
  | { type: 'TYPE_TEXT'; text: string }
  | { type: 'PINCH'; centerX: number; centerY: number; scale: number; durationMs?: number }
  | { type: 'SCROLL'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'MULTI_TAP'; x: number; y: number; count: number; intervalMs?: number }
  // MDM commands
  | { type: 'GET_DEVICE_INFO' }
  | { type: 'LOCK_DEVICE' }
  | { type: 'REBOOT_DEVICE' }
  | { type: 'WIPE_DEVICE'; confirm: string; wipeExternalStorage?: boolean }
  | { type: 'LIST_APPS'; includeSystemApps?: boolean }
  | { type: 'INSTALL_APP'; packageName: string; apkUrl: string }
  | { type: 'UNINSTALL_APP'; packageName: string };

/**
 * Device info returned by GET_DEVICE_INFO command.
 */
export interface DeviceInfo {
  type: 'DEVICE_INFO';
  deviceName: string;
  model: string;
  manufacturer: string;
  androidVersion: string;
  sdkVersion: number;
  batteryLevel: number;
  isCharging: boolean;
  wifiConnected: boolean;
  freeStorageBytes: number;
  totalStorageBytes: number;
  isDeviceOwner: boolean;
  isDeviceAdmin: boolean;
}

/**
 * App info returned by LIST_APPS command.
 */
export interface AppInfo {
  packageName: string;
  appName: string;
  versionName: string | null;
  versionCode: number;
  isSystemApp: boolean;
}

/**
 * App list returned by LIST_APPS command.
 */
export interface AppList {
  type: 'APP_LIST';
  apps: AppInfo[];
}

/**
 * Response data from MDM commands.
 */
export type CommandResponseData = DeviceInfo | AppList;

/**
 * Command acknowledgment from the device.
 */
export interface CommandAck {
  commandId: string;
  success: boolean;
  errorMessage?: string | null;
  data?: CommandResponseData | null;
  timestamp: number;
}

/**
 * Command envelope matching Android's CommandEnvelope.
 */
interface CommandEnvelope {
  id: string;
  command: RemoteCommand;
  timestamp: number;
}

let commandIdCounter = 0;
function generateCommandId(): string {
  return `cmd-${Date.now()}-${++commandIdCounter}`;
}

/** Current device screen geometry, sent by the device as SCREEN_INFO (contract C9). */
export interface ScreenInfo {
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
}

export interface UseWebRTCResult {
  connectionState: ConnectionState;
  dataChannel: RTCDataChannel | null;
  error: string | null;
  sendCommand: (command: RemoteCommand) => void;
  sendCommandWithResponse: <T extends CommandResponseData>(command: RemoteCommand) => Promise<T | null>;
  lastAck: CommandAck | null;
  disconnect: () => void;
  /** Latest SCREEN_INFO from the device (null until received). */
  screenInfo: ScreenInfo | null;
  /** Reason from a CAPTURE_FAILED message (contract C8), if any. */
  captureError: string | null;
  /** True once the device has joined the signaling room. */
  devicePresent: boolean;
  /** Subscribe to binary video messages (from the `video` channel, or `commands` as the fallback). */
  subscribeVideo: (listener: (data: ArrayBuffer) => void) => () => void;
  /** Ask the device for a keyframe (contract C9). */
  requestKeyframe: () => void;
}

/** STUN only. TURN servers and credentials come from the server (GET /api/ice-servers, contract C7). */
const FALLBACK_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

const COMMAND_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 20_000;

async function fetchIceServers(): Promise<RTCIceServer[]> {
  try {
    const res = await apiFetch(`${API_BASE}/api/ice-servers`);
    if (!res.ok) return FALLBACK_ICE_SERVERS;
    const data = (await res.json()) as { iceServers?: RTCIceServer[] };
    return Array.isArray(data.iceServers) && data.iceServers.length > 0 ? data.iceServers : FALLBACK_ICE_SERVERS;
  } catch {
    return FALLBACK_ICE_SERVERS;
  }
}

interface PendingCommand {
  resolve: (ack: CommandAck) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function useWebRTC(deviceId: string | null, signalingUrl: string): UseWebRTCResult {
  const [connectionState, setConnectionStateRaw] = useState<ConnectionState>('disconnected');
  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastAck, setLastAck] = useState<CommandAck | null>(null);
  const [screenInfo, setScreenInfo] = useState<ScreenInfo | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [devicePresent, setDevicePresent] = useState(false);

  // Mirror of connectionState for callbacks created in an earlier render (WU-09).
  const stateRef = useRef<ConnectionState>('disconnected');
  const setConnectionState = useCallback((state: ConnectionState) => {
    stateRef.current = state;
    setConnectionStateRaw(state);
  }, []);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const videoListenersRef = useRef<Set<(data: ArrayBuffer) => void>>(new Set());
  const pendingCommandsRef = useRef<Map<string, PendingCommand>>(new Map());

  const rejectAllPending = useCallback((reason: string) => {
    for (const [id, p] of pendingCommandsRef.current) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      pendingCommandsRef.current.delete(id);
    }
  }, []);

  const subscribeVideo = useCallback((listener: (data: ArrayBuffer) => void) => {
    videoListenersRef.current.add(listener);
    return () => { videoListenersRef.current.delete(listener); };
  }, []);

  const requestKeyframe = useCallback(() => {
    const dc = dataChannelRef.current;
    if (dc && dc.readyState === 'open') dc.send(JSON.stringify({ type: 'REQUEST_KEYFRAME' }));
  }, []);

  const sendCommand = useCallback((command: RemoteCommand) => {
    const dc = dataChannelRef.current;
    if (dc && dc.readyState === 'open') {
      const envelope: CommandEnvelope = {
        id: generateCommandId(),
        command,
        timestamp: Date.now(),
      };
      dc.send(JSON.stringify(envelope));
    }
  }, []);

  const sendCommandWithResponse = useCallback(<T extends CommandResponseData>(
    command: RemoteCommand
  ): Promise<T | null> => {
    return new Promise((resolve, reject) => {
      const dc = dataChannelRef.current;
      if (!dc || dc.readyState !== 'open') {
        reject(new Error('Data channel not connected'));
        return;
      }

      const envelope: CommandEnvelope = {
        id: generateCommandId(),
        command,
        timestamp: Date.now(),
      };

      const timer = setTimeout(() => {
        if (pendingCommandsRef.current.delete(envelope.id)) {
          reject(new Error('Command timed out'));
        }
      }, COMMAND_TIMEOUT_MS);

      pendingCommandsRef.current.set(envelope.id, {
        resolve: (ack: CommandAck) => {
          if (ack.success) {
            resolve(ack.data as T | null);
          } else {
            reject(new Error(ack.errorMessage || 'Command failed'));
          }
        },
        reject,
        timer,
      });

      dc.send(JSON.stringify(envelope));
    });
  }, []);

  const disconnect = useCallback(() => {
    rejectAllPending('Disconnected');
    if (dataChannelRef.current) {
      dataChannelRef.current.close();
      dataChannelRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setDataChannel(null);
    setConnectionState('disconnected');
    setError(null);
  }, [rejectAllPending, setConnectionState]);

  useEffect(() => {
    if (!deviceId) return;

    setConnectionState('connecting');
    setError(null);
    setScreenInfo(null);
    setCaptureError(null);
    setDevicePresent(false);

    // C3: the WebSocket authenticates with a single-use ticket, never the JWT.
    // A fresh ticket is fetched every time this effect (re)connects.
    // C7: ICE servers (with time-limited TURN credentials) come from the server.
    let cancelled = false;
    let teardown: (() => void) | null = null;
    Promise.all([fetchWsTicket('signaling', deviceId), fetchIceServers()]).then(
      ([ticket, iceServers]) => {
        if (cancelled) return;
        teardown = start(buildWsUrl(signalingUrl, ticket), iceServers);
      },
      (err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not get a signaling ticket');
        setConnectionState('failed');
      }
    );
    return () => {
      cancelled = true;
      teardown?.();
      rejectAllPending('Disconnected');
    };

    function start(url: string, iceServers: RTCIceServer[]): () => void {
      let closing = false;
      const fail = (message: string) => {
        setError(message);
        setConnectionState('failed');
      };

      const ws = new WebSocket(url);
      wsRef.current = ws;

      const pc = new RTCPeerConnection({ iceServers });
      pcRef.current = pc;

      // C9: `commands` is reliable and ordered; `video` is unordered with no retransmits.
      const dc = pc.createDataChannel('commands', { ordered: true });
      dataChannelRef.current = dc;
      dc.binaryType = 'arraybuffer';
      const videoChannel = pc.createDataChannel('video', { ordered: false, maxRetransmits: 0 });
      videoChannel.binaryType = 'arraybuffer';

      // A connection that never comes up must end in an error, not spin forever.
      const connectTimer = setTimeout(() => {
        if (stateRef.current === 'connecting') fail('Connection timed out');
      }, CONNECT_TIMEOUT_MS);

      const dispatchVideo = (data: unknown) => {
        if (!(data instanceof ArrayBuffer)) return;
        for (const listener of videoListenersRef.current) listener(data);
      };

      // The ONE place data channel messages are demultiplexed.
      const handleCommandsMessage = (data: unknown) => {
        if (typeof data !== 'string') {
          dispatchVideo(data); // video fallback for older devices
          return;
        }
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }
        if (msg.type === 'SCREEN_INFO') {
          setScreenInfo({
            width: Number(msg.width),
            height: Number(msg.height),
            rotation: (Number(msg.rotation) || 0) as ScreenInfo['rotation'],
          });
        } else if (msg.type === 'CAPTURE_FAILED') {
          setCaptureError(typeof msg.reason === 'string' && msg.reason ? msg.reason : 'Screen capture failed');
        } else if (typeof msg.commandId === 'string') {
          const ack = msg as unknown as CommandAck;
          setLastAck(ack);
          const pending = pendingCommandsRef.current.get(ack.commandId);
          if (pending) {
            clearTimeout(pending.timer);
            pendingCommandsRef.current.delete(ack.commandId);
            pending.resolve(ack);
          }
        }
      };

      dc.onopen = () => {
        clearTimeout(connectTimer);
        setConnectionState('connected');
        setDataChannel(dc);
      };
      dc.onclose = () => {
        if (closing) return;
        setConnectionState('disconnected');
        setDataChannel(null);
      };
      dc.onerror = () => {
        setError('Data channel error');
      };
      dc.onmessage = (event) => handleCommandsMessage(event.data);
      videoChannel.onmessage = (event) => dispatchVideo(event.data);

      pc.onicecandidate = (event) => {
        if (event.candidate && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'ice-candidate',
            candidate: event.candidate.toJSON(),
          }));
        }
      };

      pc.onconnectionstatechange = () => {
        switch (pc.connectionState) {
          case 'connected':
            clearTimeout(connectTimer);
            setConnectionState('connected');
            break;
          case 'disconnected':
          case 'closed':
            if (!closing) setConnectionState('disconnected');
            break;
          case 'failed':
            clearTimeout(connectTimer);
            fail('Connection failed');
            break;
        }
      };

      ws.onopen = () => {
        // Join room as controller
        ws.send(JSON.stringify({
          type: 'join',
          deviceId,
          role: 'controller',
        }));
      };

      ws.onmessage = async (event) => {
        try {
          const message = JSON.parse(event.data);

          switch (message.type) {
            case 'peer-joined':
              // Device joined, create and send offer
              if (message.role === 'device') {
                setDevicePresent(true);
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                ws.send(JSON.stringify({
                  type: 'offer',
                  sdp: offer.sdp,
                }));
              }
              break;

            case 'answer':
              await pc.setRemoteDescription({
                type: 'answer',
                sdp: message.sdp,
              });
              break;

            case 'ice-candidate':
              if (message.candidate) {
                await pc.addIceCandidate(message.candidate);
              }
              break;

            case 'peer-left':
              setDevicePresent(false);
              setConnectionState('disconnected');
              break;

            case 'error':
              setError(message.message);
              break;
          }
        } catch {
          setError('Error handling signaling message');
        }
      };

      ws.onerror = () => {
        if (closing) return;
        clearTimeout(connectTimer);
        fail('WebSocket connection failed');
      };

      ws.onclose = () => {
        if (closing) return;
        // Signaling is only needed to establish the connection; closing afterwards is normal.
        // stateRef (not the render-time state) is read here: this closure outlives renders.
        if (stateRef.current === 'connecting') {
          clearTimeout(connectTimer);
          fail('Signaling connection closed before the connection was established');
        }
      };

      return () => {
        closing = true;
        clearTimeout(connectTimer);
        dc.close();
        videoChannel.close();
        pc.close();
        ws.close();
        wsRef.current = null;
        pcRef.current = null;
        dataChannelRef.current = null;
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, signalingUrl]);

  return {
    connectionState, dataChannel, error, sendCommand, sendCommandWithResponse, lastAck, disconnect,
    screenInfo, captureError, devicePresent, subscribeVideo, requestKeyframe,
  };
}
