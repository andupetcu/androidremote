import { useState, useEffect, useRef, useCallback } from 'react';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'failed';

export interface UseWebRTCResult {
  connectionState: ConnectionState;
  dataChannel: RTCDataChannel | null;
  error: string | null;
  sendCommand: (command: object) => void;
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export function useWebRTC(deviceId: string | null, signalingUrl: string): UseWebRTCResult {
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);

  const sendCommand = useCallback((command: object) => {
    const dc = dataChannelRef.current;
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify(command));
    }
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

    // Handle ICE candidates
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

  return { connectionState, dataChannel, error, sendCommand };
}
