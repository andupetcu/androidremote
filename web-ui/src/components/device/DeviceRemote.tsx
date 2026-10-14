import { useState, useRef, useCallback } from 'react';
import { RemoteScreen } from '../RemoteScreen';
import { RelayRemoteScreen } from '../RelayRemoteScreen';
import { Button } from '../ui/Button';
import type { ConnectionState } from '../../hooks/useWebRTC';
import { API_BASE, apiFetch } from '../../utils/api';
import { errorMessage } from '../../hooks/useCommands';
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

// --- Android: WebRTC path ---

function AndroidDeviceRemote({ deviceId }: { deviceId: string }) {
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [phase, setPhase] = useState<'idle' | 'sending' | 'active'>('idle');
  const [startError, setStartError] = useState<string | null>(null);
  const connectingRef = useRef(false);
  const disconnectWebRTCRef = useRef<(() => void) | null>(null);

  const cleanupSession = useCallback(() => {
    // Tear down current WebRTC session if active
    if (disconnectWebRTCRef.current) {
      disconnectWebRTCRef.current();
    }
  }, []);

  const handleConnect = useCallback(async () => {
    if (connectingRef.current) return;
    connectingRef.current = true;

    // Auto-cleanup any existing session before starting a new one
    if (phase === 'active') {
      cleanupSession();
    }
    setPhase('sending');
    setStartError(null);

    // The device only starts its session after START_REMOTE is accepted. Once the server has
    // queued it we open the remote screen straight away: its signaling room tolerates a late
    // peer-joined, reports "device not present / timed out" after 20 s, and shows CAPTURE_FAILED.
    // (Replaces the fixed 6 s sleep that also ignored a rejected command.)
    try {
      const response = await apiFetch(`${API_BASE}/api/devices/${deviceId}/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'START_REMOTE',
          payload: {},
        }),
      });

      if (!response.ok) {
        setStartError(`Could not start the remote session: ${await errorMessage(response, 'request failed')}`);
        setPhase('idle');
        connectingRef.current = false;
        return;
      }
    } catch (err) {
      setStartError(`Could not start the remote session: ${err instanceof Error ? err.message : 'network error'}`);
      setPhase('idle');
      connectingRef.current = false;
      return;
    }

    connectingRef.current = false;
    setPhase('active');
  }, [deviceId, phase, cleanupSession]);

  const handleDisconnect = useCallback(() => {
    cleanupSession();
    setPhase('idle');
    connectingRef.current = false;
    setConnectionState('disconnected');
  }, [cleanupSession]);

  const handleReconnect = useCallback(() => {
    cleanupSession();
    setPhase('idle');
    setConnectionState('disconnected');
    // Use setTimeout to let React unmount RemoteScreen before reconnecting
    setTimeout(() => {
      handleConnect();
    }, 0);
  }, [cleanupSession, handleConnect]);

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
          {phase === 'active' && (connectionState === 'disconnected' || connectionState === 'failed') && (
            <>
              <Button variant="primary" size="sm" onClick={handleReconnect}>
                Reconnect
              </Button>
              <Button variant="danger" size="sm" onClick={handleDisconnect}>
                End Session
              </Button>
            </>
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
            {startError && <p role="alert" className="device-remote__error">{startError}</p>}
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
            disconnectRef={disconnectWebRTCRef}
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
      const statusResp = await apiFetch(`${API_BASE}/api/agent/status/${deviceId}`);
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
