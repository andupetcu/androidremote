import { useState } from 'react';
import { RemoteScreen } from './components/RemoteScreen';
import type { ConnectionState } from './hooks/useWebRTC';
import './App.css';

// Use relative WebSocket URL - will be proxied by Vite in dev
const SIGNALING_URL = `ws://${window.location.host}/ws`;

function App() {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [inputDeviceId, setInputDeviceId] = useState('');
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');

  const handleConnect = () => {
    if (inputDeviceId.trim()) {
      setDeviceId(inputDeviceId.trim());
    }
  };

  const handleDisconnect = () => {
    setDeviceId(null);
    setConnectionState('disconnected');
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>Android Remote</h1>
        <span className={`status-badge status-badge--${connectionState}`}>
          {connectionState}
        </span>
      </header>

      <main className="app-main">
        {!deviceId ? (
          <div className="connect-panel">
            <h2>Connect to Device</h2>
            <p>Enter the device ID shown on your Android device:</p>
            <div className="connect-form">
              <input
                type="text"
                value={inputDeviceId}
                onChange={(e) => setInputDeviceId(e.target.value)}
                placeholder="Device ID (e.g., abc123)"
                onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
              />
              <button onClick={handleConnect} disabled={!inputDeviceId.trim()}>
                Connect
              </button>
            </div>
          </div>
        ) : (
          <div className="session-panel">
            <div className="session-controls">
              <span>Device: {deviceId}</span>
              <button onClick={handleDisconnect} className="disconnect-btn">
                Disconnect
              </button>
            </div>
            <RemoteScreen
              deviceId={deviceId}
              signalingUrl={SIGNALING_URL}
              onConnectionStateChange={setConnectionState}
            />
          </div>
        )}
      </main>

      <footer className="app-footer">
        <p>
          Controls: Click to tap • Drag to swipe • Hold for long press • Esc for back
        </p>
      </footer>
    </div>
  );
}

export default App;
