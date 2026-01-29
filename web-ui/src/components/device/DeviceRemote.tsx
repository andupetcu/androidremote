import { useState, useEffect, useRef } from 'react';
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
        } else {
          console.error('Failed to send START_REMOTE:', response.statusText);
          setStartRemoteSent(true);
        }
      } catch (err) {
        console.error('Error sending START_REMOTE:', err);
        setStartRemoteSent(true);
      }
    };

    sendStartRemote();
  }, [deviceId]);

  const handleReconnect = () => {
    commandSentRef.current = false;
    setStartRemoteSent(false);
    setConnectionState('disconnected');
  };

  return (
    <div className="device-remote">
      <div className="device-remote__header">
        <span className={`device-remote__status device-remote__status--${connectionState}`}>
          {connectionState}
        </span>
        {connectionState === 'failed' && (
          <Button variant="secondary" size="sm" onClick={handleReconnect}>
            Reconnect
          </Button>
        )}
      </div>
      <div className="device-remote__screen">
        {!startRemoteSent ? (
          <div className="device-remote__connecting">
            <div className="spinner" />
            <p>Sending connection request to device...</p>
          </div>
        ) : (
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
