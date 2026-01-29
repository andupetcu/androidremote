import { useState, useRef, useCallback } from 'react';
import { RemoteScreen } from '../RemoteScreen';
import { Button } from '../ui/Button';
import type { ConnectionState } from '../../hooks/useWebRTC';
import './DeviceComponents.css';

// Both browser and device connect directly to the signaling server.
// The Vite dev proxy doesn't reliably forward WebSocket upgrades,
// so we bypass it and connect to the production signaling server directly.
const SIGNALING_URL = 'wss://mdmadmin.footprints.media/ws';

interface DeviceRemoteProps {
  deviceId: string;
}

export function DeviceRemote({ deviceId }: DeviceRemoteProps) {
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [phase, setPhase] = useState<'idle' | 'sending' | 'active'>('idle');
  const connectingRef = useRef(false);

  const handleConnect = useCallback(async () => {
    if (connectingRef.current) return;
    connectingRef.current = true;
    setPhase('sending');

    try {
      const response = await fetch(`/api/devices/${deviceId}/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'START_REMOTE',
          payload: { signalingUrl: SIGNALING_URL },
        }),
      });

      if (response.ok) {
        console.log('START_REMOTE command sent, waiting for device...');
      } else {
        console.error('Failed to send START_REMOTE:', response.statusText);
      }
    } catch (err) {
      console.error('Error sending START_REMOTE:', err);
    }

    // Give device time to start its session before we connect WebRTC
    await new Promise(resolve => setTimeout(resolve, 6000));
    connectingRef.current = false;
    setPhase('active');
  }, [deviceId]);

  const handleDisconnect = useCallback(() => {
    setPhase('idle');
    connectingRef.current = false;
    setConnectionState('disconnected');
  }, []);

  return (
    <div className="device-remote">
      <div className="device-remote__header">
        <span className={`device-remote__status device-remote__status--${connectionState}`}>
          {connectionState}
        </span>
        <div className="device-remote__actions">
          {phase === 'idle' && (
            <Button variant="primary" size="sm" onClick={handleConnect}>
              Connect
            </Button>
          )}
          {phase === 'active' && connectionState === 'connected' && (
            <Button variant="danger" size="sm" onClick={handleDisconnect}>
              End Session
            </Button>
          )}
        </div>
      </div>
      <div className="device-remote__screen">
        {phase === 'idle' && (
          <div className="device-remote__disconnected">
            <p>Click Connect to start a remote session.</p>
          </div>
        )}
        {phase === 'sending' && (
          <div className="device-remote__connecting">
            <div className="spinner" />
            <p>Sending connection request to device...</p>
          </div>
        )}
        {phase === 'active' && (
          <RemoteScreen
            deviceId={deviceId}
            signalingUrl={SIGNALING_URL}
            onConnectionStateChange={setConnectionState}
          />
        )}
      </div>
      <div className="device-remote__controls">
        <p>Controls: Click to tap | Drag to swipe | Hold for long press | Esc for back</p>
      </div>
    </div>
  );
}
