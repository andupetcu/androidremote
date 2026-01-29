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
  // MDM commands
  | { type: 'GET_DEVICE_INFO' }
  | { type: 'LOCK_DEVICE' }
  | { type: 'REBOOT_DEVICE' }
  | { type: 'WIPE_DEVICE'; wipeExternalStorage?: boolean }
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

export interface UseWebRTCResult {
  connectionState: ConnectionState;
  dataChannel: RTCDataChannel | null;
  error: string | null;
  sendCommand: (command: RemoteCommand) => void;
  sendCommandWithResponse: <T extends CommandResponseData>(command: RemoteCommand) => Promise<T | null>;
  lastAck: CommandAck | null;
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // Free TURN server for development testing (Open Relay Project)
  // Uses static auth - see https://www.metered.ca/tools/openrelay/
  {
    urls: [
      'turn:a.relay.metered.ca:80',
      'turn:a.relay.metered.ca:80?transport=tcp',
      'turn:a.relay.metered.ca:443',
      'turn:a.relay.metered.ca:443?transport=tcp',
    ],
    username: 'e8dd65b92f3aef1c190c914f',
    credential: '4F2oRAyF/Br8Xijx',
  },
];

export function useWebRTC(deviceId: string | null, signalingUrl: string): UseWebRTCResult {
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastAck, setLastAck] = useState<CommandAck | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const pendingCommandsRef = useRef<Map<string, {
    resolve: (ack: CommandAck) => void;
    reject: (error: Error) => void;
  }>>(new Map());

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

      // Store pending promise
      pendingCommandsRef.current.set(envelope.id, {
        resolve: (ack: CommandAck) => {
          if (ack.success) {
            resolve(ack.data as T | null);
          } else {
            reject(new Error(ack.errorMessage || 'Command failed'));
          }
        },
        reject,
      });

      // Set timeout for response
      setTimeout(() => {
        if (pendingCommandsRef.current.has(envelope.id)) {
          pendingCommandsRef.current.delete(envelope.id);
          reject(new Error('Command timed out'));
        }
      }, 30000);

      dc.send(JSON.stringify(envelope));
    });
  }, []);

  useEffect(() => {
    if (!deviceId) return;

    setConnectionState('connecting');
    setError(null);

    // Create WebSocket connection
    const ws = new WebSocket(signalingUrl);
    wsRef.current = ws;

    // Create peer connection
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pcRef.current = pc;

    // Create data channel (as offerer/controller)
    const dc = pc.createDataChannel('commands', {
      ordered: false,
      maxRetransmits: 0,
    });
    dataChannelRef.current = dc;

    dc.binaryType = 'arraybuffer';

    dc.onopen = () => {
      console.log('[WebRTC] Data channel opened, label:', dc.label, 'id:', dc.id);
      setConnectionState('connected');
      setDataChannel(dc);
    };

    dc.onclose = () => {
      setConnectionState('disconnected');
      setDataChannel(null);
    };

    dc.onerror = () => {
      setError('Data channel error');
    };

    dc.onmessage = (event) => {
      try {
        const ack: CommandAck = JSON.parse(event.data);
        if (ack.commandId) {
          setLastAck(ack);

          // Resolve pending promise if exists
          const pending = pendingCommandsRef.current.get(ack.commandId);
          if (pending) {
            pendingCommandsRef.current.delete(ack.commandId);
            pending.resolve(ack);
          }
        }
      } catch (e) {
        console.error('Error parsing data channel message:', e);
      }
    };

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate && ws.readyState === WebSocket.OPEN) {
        // Log candidate type to diagnose connectivity
        const candidateStr = event.candidate.candidate;
        const type = candidateStr.includes('typ relay') ? 'RELAY (TURN)' :
                     candidateStr.includes('typ srflx') ? 'SRFLX (STUN)' :
                     candidateStr.includes('typ host') ? 'HOST' : 'UNKNOWN';
        console.log(`[WebRTC] ICE candidate: ${type}`, candidateStr);

        ws.send(JSON.stringify({
          type: 'ice-candidate',
          candidate: event.candidate.toJSON(),
        }));
      } else if (!event.candidate) {
        console.log('[WebRTC] ICE gathering complete');
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('[WebRTC] connectionState:', pc.connectionState);
      switch (pc.connectionState) {
        case 'connected':
          setConnectionState('connected');
          break;
        case 'disconnected':
        case 'closed':
          setConnectionState('disconnected');
          break;
        case 'failed':
          setConnectionState('failed');
          setError('Connection failed');
          break;
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log('[WebRTC] iceConnectionState:', pc.iceConnectionState);
    };

    pc.onicegatheringstatechange = () => {
      console.log('[WebRTC] iceGatheringState:', pc.iceGatheringState);
    };

    // WebSocket message handling
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
            setConnectionState('disconnected');
            break;

          case 'error':
            setError(message.message);
            break;
        }
      } catch (e) {
        console.error('Error handling signaling message:', e);
      }
    };

    ws.onerror = () => {
      setError('WebSocket connection failed');
      setConnectionState('failed');
    };

    ws.onclose = () => {
      if (connectionState === 'connecting') {
        setError('Could not connect to signaling server');
        setConnectionState('failed');
      }
    };

    // Cleanup
    return () => {
      dc.close();
      pc.close();
      ws.close();
      wsRef.current = null;
      pcRef.current = null;
      dataChannelRef.current = null;
    };
  }, [deviceId, signalingUrl]);

  return { connectionState, dataChannel, error, sendCommand, sendCommandWithResponse, lastAck };
}
