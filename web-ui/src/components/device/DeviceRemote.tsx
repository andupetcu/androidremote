import { useState, useEffect, useRef, useCallback } from 'react';
import { RemoteScreen } from '../RemoteScreen';
import { Button } from '../ui/Button';
import type { ConnectionState } from '../../hooks/useWebRTC';
import './DeviceComponents.css';

const API_BASE_URL = import.meta.env.DEV
  ? `http://${window.location.hostname}:7899`
  : '';
const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const SIGNALING_URL = import.meta.env.DEV
  ? `ws://${window.location.hostname}:7899/ws`
  : `${WS_PROTOCOL}//${window.location.host}/ws`;

interface DeviceRemoteProps {
  deviceId: string;
}

export function DeviceRemote({ deviceId }: DeviceRemoteProps) {
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [startRemoteSent, setStartRemoteSent] = useState(false);
  const [sessionActive, setSessionActive] = useState(false);
  const commandSentRef = useRef(false);

  useEffect(() => {
    if (commandSentRef.current) return;

    const sendStartRemote = async () => {
      try {
        commandSentRef.current = true;
        const response = await fetch(`${API_BASE_URL}/api/devices/${deviceId}/commands`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'START_REMOTE',
            payload: { signalingUrl: SIGNALING_URL },
          }),
        });

        if (response.ok) {
          console.log('START_REMOTE command sent, waiting for device...');
          await new Promise(resolve => setTimeout(resolve, 6000));
          setStartRemoteSent(true);
          setSessionActive(true);
        } else {
          console.error('Failed to send START_REMOTE:', response.statusText);
          setStartRemoteSent(true);
          setSessionActive(true);
        }
      } catch (err) {
        console.error('Error sending START_REMOTE:', err);
        setStartRemoteSent(true);
        setSessionActive(true);
      }
    };

    sendStartRemote();
  }, [deviceId]);

  const handleReconnect = useCallback(() => {
    commandSentRef.current = false;
    setStartRemoteSent(false);
    setSessionActive(false);
    setConnectionState('disconnected');
  }, []);

  const handleDisconnect = useCallback(() => {
    setSessionActive(false);
    setStartRemoteSent(false);
    commandSentRef.current = false;
    setConnectionState('disconnected');
  }, []);

  return (
    <div className="device-remote">
      <div className="device-remote__header">
        <span className={`device-remote__status device-remote__status--${connectionState}`}>
          {connectionState}
        </span>
        <div className="device-remote__actions">
          {(connectionState === 'failed' || connectionState === 'disconnected') && !sessionActive && (
            <Button variant="primary" size="sm" onClick={handleReconnect}>
              Connect
            </Button>
          )}
          {sessionActive && connectionState === 'connected' && (
            <Button variant="danger" size="sm" onClick={handleDisconnect}>
              End Session
            </Button>
          )}
        </div>
      </div>
      <div className="device-remote__screen">
        {!startRemoteSent ? (
          !sessionActive ? (
            <div className="device-remote__disconnected">
              <p>Remote session ended.</p>
            </div>
          ) : (
            <div className="device-remote__connecting">
              <div className="spinner" />
              <p>Sending connection request to device...</p>
            </div>
          )
        ) : sessionActive ? (
          <RemoteScreen
            deviceId={deviceId}
            signalingUrl={SIGNALING_URL}
            onConnectionStateChange={setConnectionState}
          />
        ) : (
          <div className="device-remote__disconnected">
            <p>Remote session ended.</p>
          </div>
        )}
      </div>
      <div className="device-remote__controls">
        <p>Controls: Click to tap | Drag to swipe | Hold for long press | Esc for back</p>
      </div>
    </div>
  );
}
