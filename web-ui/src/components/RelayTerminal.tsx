import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useRelayWebSocket } from '../hooks/useRelayWebSocket';
import { useAuth } from '../hooks/useAuth';
import * as Protocol from '../lib/BinaryProtocol';

export interface RelayTerminalProps {
  deviceId: string;
}

export function RelayTerminal({ deviceId }: RelayTerminalProps) {
  const { token } = useAuth();
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const onMessage = useCallback((msg: Protocol.ProtocolMessage) => {
    if (msg.header.type === Protocol.TERMINAL_DATA) {
      xtermRef.current?.write(msg.payload);
    } else if (msg.header.type === Protocol.TERMINAL_CLOSE) {
      xtermRef.current?.write('\r\n\x1b[31m[Terminal session closed]\x1b[0m\r\n');
    }
  }, []);

  const { state, connect, disconnect, sendTerminalData, sendTerminalResize } =
    useRelayWebSocket({
      deviceId,
      sessionType: 'terminal',
      token: token || '',
      autoConnect: false,
      onMessage,
    });

  // Initialize xterm.js
  useEffect(() => {
    if (!termRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1a1a2e',
        foreground: '#eee',
        cursor: '#e94560',
        selectionBackground: '#0f3460',
      },
      scrollback: 5000,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(termRef.current);

    // Initial fit
    try {
      fitAddon.fit();
    } catch {
      // Element may not be visible yet
    }

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Handle user input -> send to agent
    const inputDisposable = term.onData((data: string) => {
      sendTerminalData(data);
    });

    // Handle binary input (paste etc)
    const binaryDisposable = term.onBinary((data: string) => {
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) {
        bytes[i] = data.charCodeAt(i);
      }
      sendTerminalData(bytes);
    });

    return () => {
      inputDisposable.dispose();
      binaryDisposable.dispose();
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
    // sendTerminalData is stable via useCallback in the hook
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle resize
  useEffect(() => {
    const fitAddon = fitAddonRef.current;
    const term = xtermRef.current;
    if (!fitAddon || !term) return;

    const handleResize = () => {
      try {
        fitAddon.fit();
        sendTerminalResize(term.cols, term.rows);
      } catch {
        // Ignore if not visible
      }
    };

    const resizeObserver = new ResizeObserver(handleResize);
    if (termRef.current) {
      resizeObserver.observe(termRef.current);
    }

    return () => {
      resizeObserver.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendTerminalResize]);

  // Auto-connect when token is available
  useEffect(() => {
    if (token && state === 'disconnected') {
      connect();
    }
    return () => {
      disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Send initial resize once connected
  useEffect(() => {
    if (state === 'connected' && xtermRef.current && fitAddonRef.current) {
      try {
        fitAddonRef.current.fit();
        sendTerminalResize(xtermRef.current.cols, xtermRef.current.rows);
      } catch {
        // Ignore
      }
    }
  }, [state, sendTerminalResize]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: '400px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0.5rem 1rem',
          backgroundColor: '#16213e',
          borderBottom: '1px solid #0f3460',
          fontSize: '0.875rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor:
                state === 'connected'
                  ? '#0f9d58'
                  : state === 'connecting'
                    ? '#f9a825'
                    : '#666',
            }}
          />
          <span style={{ color: '#888' }}>
            {state === 'connected'
              ? 'Terminal connected'
              : state === 'connecting'
                ? 'Connecting...'
                : state === 'error'
                  ? 'Connection error'
                  : 'Disconnected'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {state !== 'connected' && state !== 'connecting' && (
            <button
              onClick={connect}
              style={{
                padding: '0.25rem 0.75rem',
                fontSize: '0.75rem',
                backgroundColor: '#0f3460',
                color: '#eee',
                border: '1px solid #0f3460',
                borderRadius: '0.25rem',
                cursor: 'pointer',
              }}
            >
              Connect
            </button>
          )}
          {state === 'connected' && (
            <button
              onClick={disconnect}
              style={{
                padding: '0.25rem 0.75rem',
                fontSize: '0.75rem',
                backgroundColor: 'transparent',
                color: '#888',
                border: '1px solid #333',
                borderRadius: '0.25rem',
                cursor: 'pointer',
              }}
            >
              Disconnect
            </button>
          )}
        </div>
      </div>
      <div
        ref={termRef}
        style={{
          flex: 1,
          padding: '4px',
          backgroundColor: '#1a1a2e',
        }}
      />
    </div>
  );
}
