import { useState, useRef, useCallback } from 'react';
import { RemoteScreen } from '../RemoteScreen';
import { RelayRemoteScreen } from '../RelayRemoteScreen';
import { Button } from '../ui/Button';
import type { ConnectionState } from '../../hooks/useWebRTC';
import { apiFetch } from '../../utils/api';
import './DeviceComponents.css';

/**
 * Derive the signaling WebSocket URL from the current page origin.
 * In production: https://example.com → wss://example.com/ws
 * In development: http://localhost:5173 → ws://localhost:5173/ws (proxied by Vite)
 */
function getSignalingUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

/**
 * Derive the relay WebSocket URL for cross-platform agents.
 */
function getRelayUrl(deviceId: string, session: string, token: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/relay?deviceId=${encodeURIComponent(deviceId)}&session=${session}&token=${encodeURIComponent(token)}`;
}

interface DeviceRemoteProps {
  deviceId: string;
  osType?: string;
}

export function DeviceRemote({ deviceId, osType = 'android' }: DeviceRemoteProps) {
  const isRelayDevice = osType !== 'android';

  if (isRelayDevice) {
    return <RelayDeviceRemote deviceId={deviceId} osType={osType} />;
  }

  return <AndroidDeviceRemote deviceId={deviceId} />;
}

// --- Android: WebRTC path (unchanged) ---

function AndroidDeviceRemote({ deviceId }: { deviceId: string }) {
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [phase, setPhase] = useState<'idle' | 'sending' | 'active'>('idle');
  const connectingRef = useRef(false);

  const handleConnect = useCallback(async () => {
    if (connectingRef.current) return;
    connectingRef.current = true;
    setPhase('sending');

    try {
      const response = await apiFetch(`/api/devices/${deviceId}/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'START_REMOTE',
          payload: {},
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
            signalingUrl={getSignalingUrl()}
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

// --- Linux/Windows: Relay path (new) ---

function RelayDeviceRemote({ deviceId, osType }: { deviceId: string; osType: string }) {
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const handleConnect = useCallback(async () => {
    setPhase('connecting');
    setError(null);

    try {
      // Check if agent is connected
      const statusResp = await apiFetch(`/api/agent/status/${deviceId}`);
      const status = await statusResp.json();

      if (!status.connected) {
        setError('Agent is not connected. Ensure the agent is running on the remote device.');
        setPhase('error');
        return;
      }

      setPhase('connected');
    } catch (err) {
      setError(`Failed to connect: ${err instanceof Error ? err.message : 'unknown error'}`);
      setPhase('error');
    }
  }, [deviceId]);

  const handleDisconnect = useCallback(() => {
    setPhase('idle');
    setError(null);
  }, []);

  return (
    <div className="device-remote">
      <div className="device-remote__header">
        <span className={`device-remote__status device-remote__status--${phase}`}>
          {phase === 'connected' ? 'online' : phase}
        </span>
        <span className="device-remote__badge">{osType}</span>
        <div className="device-remote__actions">
          {(phase === 'idle' || phase === 'error') && (
            <Button variant="primary" size="sm" onClick={handleConnect}>
              Connect Desktop
            </Button>
          )}
          {phase === 'connected' && (
            <Button variant="danger" size="sm" onClick={handleDisconnect}>
              Disconnect
            </Button>
          )}
        </div>
      </div>
      <div className="device-remote__screen">
        {phase === 'idle' && (
          <div className="device-remote__disconnected">
            <p>Click Connect Desktop to start a remote desktop session via relay.</p>
            <p className="device-remote__hint">
              This device uses the cross-platform agent ({osType}).
              Desktop streaming, terminal, and file access are available.
            </p>
          </div>
        )}
        {phase === 'connecting' && (
          <div className="device-remote__connecting">
            <div className="spinner" />
            <p>Connecting to {osType} agent...</p>
          </div>
        )}
        {phase === 'error' && (
          <div className="device-remote__disconnected">
            <p className="device-remote__error">{error}</p>
          </div>
        )}
        {phase === 'connected' && (
          <RelayRemoteScreen deviceId={deviceId} />
        )}
      </div>
      <div className="device-remote__controls">
        <p>Controls: Full keyboard and mouse input (desktop mode)</p>
      </div>
    </div>
  );
}

// Export for use in other components
export { getRelayUrl };
