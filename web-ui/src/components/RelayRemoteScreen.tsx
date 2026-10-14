import { useEffect, useRef, useCallback, useState } from 'react';
import { useRelayWebSocket } from '../hooks/useRelayWebSocket';
import { useAuth } from '../hooks/useAuth';
import * as Protocol from '../lib/BinaryProtocol';

export interface RelayRemoteScreenProps {
  deviceId: string;
}

// Desktop input sub-types (matches protocol)
const INPUT_MOUSE_MOVE = 0x01;
const INPUT_MOUSE_BUTTON = 0x02;
const INPUT_MOUSE_SCROLL = 0x03;
const INPUT_KEY_EVENT = 0x04;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

export function RelayRemoteScreen({ deviceId }: RelayRemoteScreenProps) {
  const { token } = useAuth();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [screenSize, setScreenSize] = useState<{ w: number; h: number } | null>(null);
  const [scale, setScale] = useState(1);
  const screenSizeRef = useRef(screenSize);
  screenSizeRef.current = screenSize;

  // Tiles are decoded concurrently but drawn strictly in arrival order (WU-11).
  const drawChainRef = useRef<Promise<void>>(Promise.resolve());

  const onMessage = useCallback((msg: Protocol.ProtocolMessage) => {
    if (msg.header.type === Protocol.DESKTOP_FRAME) {
      const decoded = decodeTile(msg.payload);
      drawChainRef.current = drawChainRef.current.then(() => drawTile(canvasRef.current, decoded));
    } else if (msg.header.type === Protocol.DESKTOP_RESIZE) {
      if (msg.payload.length >= 4) {
        const view = new DataView(msg.payload.buffer, msg.payload.byteOffset, msg.payload.byteLength);
        const w = view.getUint16(0, true);
        const h = view.getUint16(2, true);
        setScreenSize({ w, h });
      }
    }
  }, []);

  const { state, connect, disconnect, send } = useRelayWebSocket({
    deviceId,
    sessionType: 'desktop',
    token: token || '',
    autoConnect: false,
    onMessage,
  });

  // Set canvas dimensions when screen size changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !screenSize) return;
    canvas.width = screenSize.w;
    canvas.height = screenSize.h;
  }, [screenSize]);

  // Compute scale for display
  useEffect(() => {
    if (!screenSize || !containerRef.current) return;

    const updateScale = () => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const sx = rect.width / screenSize.w;
      const sy = (rect.height - 48) / screenSize.h; // subtract header height
      setScale(Math.min(sx, sy, 1));
    };

    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [screenSize]);

  // Auto-connect
  useEffect(() => {
    if (token && state === 'disconnected') {
      connect();
    }
    return () => {
      userDisconnectedRef.current = true;
      disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Reconnect after an unexpected drop. connect() fetches a fresh single-use ticket.
  const userDisconnectedRef = useRef(false);
  const attemptsRef = useRef(0);
  useEffect(() => {
    if (state === 'connected') {
      attemptsRef.current = 0;
      return;
    }
    if (!token || userDisconnectedRef.current) return;
    if (state !== 'disconnected' && state !== 'error') return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attemptsRef.current, RECONNECT_MAX_MS);
    const timer = window.setTimeout(() => {
      attemptsRef.current += 1;
      connect();
    }, delay);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, token]);

  const handleManualConnect = useCallback(() => {
    userDisconnectedRef.current = false;
    attemptsRef.current = 0;
    connect();
  }, [connect]);

  const handleManualDisconnect = useCallback(() => {
    userDisconnectedRef.current = true;
    disconnect();
  }, [disconnect]);

  // --- Input Handlers ---

  const toScreenCoords = useCallback(
    (clientX: number, clientY: number): [number, number] | null => {
      const canvas = canvasRef.current;
      if (!canvas || !screenSizeRef.current) return null;
      const rect = canvas.getBoundingClientRect();
      const x = ((clientX - rect.left) / rect.width) * screenSizeRef.current.w;
      const y = ((clientY - rect.top) / rect.height) * screenSizeRef.current.h;
      return [Math.round(x), Math.round(y)];
    },
    []
  );

  const sendDesktopInput = useCallback(
    (inputType: number, data: Uint8Array) => {
      const payload = new Uint8Array(1 + data.length);
      payload[0] = inputType;
      payload.set(data, 1);
      const msg = Protocol.encode(Protocol.DESKTOP_INPUT, 0, 0, payload);
      send(msg);
    },
    [send]
  );

  // Mouse moves are coalesced to one message per animation frame (latest position wins).
  const pendingMoveRef = useRef<[number, number] | null>(null);
  const moveRafRef = useRef<number | null>(null);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const coords = toScreenCoords(e.clientX, e.clientY);
      if (!coords) return;
      pendingMoveRef.current = coords;
      if (moveRafRef.current !== null) return;
      moveRafRef.current = requestAnimationFrame(() => {
        moveRafRef.current = null;
        const c = pendingMoveRef.current;
        pendingMoveRef.current = null;
        if (!c) return;
        const buf = new Uint8Array(4);
        const view = new DataView(buf.buffer);
        view.setUint16(0, c[0], true);
        view.setUint16(2, c[1], true);
        sendDesktopInput(INPUT_MOUSE_MOVE, buf);
      });
    },
    [toScreenCoords, sendDesktopInput]
  );

  useEffect(() => () => {
    if (moveRafRef.current !== null) cancelAnimationFrame(moveRafRef.current);
  }, []);

  // Keys and buttons currently held on the remote, so they can be released on blur (WU-11).
  const heldKeysRef = useRef<Set<number>>(new Set());
  const heldButtonsRef = useRef<Set<number>>(new Set());

  const sendKeyRelease = useCallback(
    (scancode: number) => {
      const buf = new Uint8Array(4);
      const view = new DataView(buf.buffer);
      view.setUint16(0, scancode, true);
      buf[2] = 1; // release
      buf[3] = 0;
      sendDesktopInput(INPUT_KEY_EVENT, buf);
    },
    [sendDesktopInput]
  );

  const sendButtonRelease = useCallback(
    (btn: number) => {
      sendDesktopInput(INPUT_MOUSE_BUTTON, Uint8Array.of(btn, 1));
    },
    [sendDesktopInput]
  );

  const releaseAll = useCallback(() => {
    for (const code of heldKeysRef.current) sendKeyRelease(code);
    heldKeysRef.current.clear();
    for (const btn of heldButtonsRef.current) sendButtonRelease(btn);
    heldButtonsRef.current.clear();
  }, [sendKeyRelease, sendButtonRelease]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const btn = e.button === 0 ? 0 : e.button === 2 ? 1 : 2; // left=0, right=1, middle=2
      heldButtonsRef.current.add(btn);
      const buf = new Uint8Array(2);
      buf[0] = btn;
      buf[1] = 0; // press
      sendDesktopInput(INPUT_MOUSE_BUTTON, buf);
    },
    [sendDesktopInput]
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const btn = e.button === 0 ? 0 : e.button === 2 ? 1 : 2;
      heldButtonsRef.current.delete(btn);
      const buf = new Uint8Array(2);
      buf[0] = btn;
      buf[1] = 1; // release
      sendDesktopInput(INPUT_MOUSE_BUTTON, buf);
    },
    [sendDesktopInput]
  );

  const handleMouseLeave = useCallback(() => {
    for (const btn of heldButtonsRef.current) sendButtonRelease(btn);
    heldButtonsRef.current.clear();
  }, [sendButtonRelease]);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const dx = Math.sign(e.deltaX);
      const dy = Math.sign(e.deltaY);
      const buf = new Uint8Array(4);
      const view = new DataView(buf.buffer);
      view.setInt16(0, dx, true);
      view.setInt16(2, dy, true);
      sendDesktopInput(INPUT_MOUSE_SCROLL, buf);
    },
    [sendDesktopInput]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.preventDefault();
      // Use e.code to get physical key position, map to scancode
      const scancode = codeToScancode(e.code);
      if (scancode === 0) return;
      heldKeysRef.current.add(scancode);

      const mods =
        (e.shiftKey ? 0x01 : 0) |
        (e.ctrlKey ? 0x02 : 0) |
        (e.altKey ? 0x04 : 0) |
        (e.metaKey ? 0x08 : 0);

      const buf = new Uint8Array(4);
      const view = new DataView(buf.buffer);
      view.setUint16(0, scancode, true);
      buf[2] = 0; // press
      buf[3] = mods;
      sendDesktopInput(INPUT_KEY_EVENT, buf);
    },
    [sendDesktopInput]
  );

  const handleKeyUp = useCallback(
    (e: React.KeyboardEvent) => {
      e.preventDefault();
      const scancode = codeToScancode(e.code);
      if (scancode === 0) return;
      heldKeysRef.current.delete(scancode);
      sendKeyRelease(scancode);
    },
    [sendKeyRelease]
  );

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: '400px',
        backgroundColor: '#0a0a1a',
      }}
    >
      {/* Header bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0.5rem 1rem',
          backgroundColor: '#16213e',
          borderBottom: '1px solid #0f3460',
          fontSize: '0.875rem',
          flexShrink: 0,
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
              ? `Desktop ${screenSize ? `${screenSize.w}x${screenSize.h}` : 'connected'}`
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
              onClick={handleManualConnect}
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
              onClick={handleManualDisconnect}
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

      {/* Canvas area */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        <canvas
          ref={canvasRef}
          tabIndex={0}
          style={{
            display: screenSize ? 'block' : 'none',
            cursor: 'default',
            outline: 'none',
            transform: `scale(${scale})`,
            transformOrigin: 'center center',
            imageRendering: 'auto',
          }}
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          onBlur={releaseAll}
          onWheel={handleWheel}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onContextMenu={handleContextMenu}
        />
        {!screenSize && state === 'connected' && (
          <div style={{ color: '#888', textAlign: 'center' }}>
            <p>Waiting for desktop stream...</p>
          </div>
        )}
        {state !== 'connected' && state !== 'connecting' && (
          <div style={{ color: '#888', textAlign: 'center' }}>
            <p>Click Connect to start a remote desktop session.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Tile rendering ---

interface DecodedTile {
  x: number;
  y: number;
  bitmap: Promise<ImageBitmap | null>;
}

/** Start decoding a tile immediately; drawing is sequenced separately. */
function decodeTile(payload: Uint8Array): DecodedTile | null {
  if (payload.length < 10) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const x = view.getUint16(0, true);
  const y = view.getUint16(2, true);
  // w and h are at offset 4 and 6; the blob decode handles size. encoding = payload[8], flags = payload[9]
  const jpegData = payload.subarray(10);
  if (jpegData.length === 0) return null;
  const blob = new Blob([jpegData as BlobPart], { type: 'image/jpeg' });
  return { x, y, bitmap: createImageBitmap(blob).catch(() => null) };
}

/** Draw a decoded tile. Called through a promise chain so tiles land in arrival order. */
async function drawTile(canvas: HTMLCanvasElement | null, tile: DecodedTile | null): Promise<void> {
  if (!tile) return;
  const bitmap = await tile.bitmap;
  if (!bitmap) return; // undecodable tile: skip it
  try {
    const ctx = canvas?.getContext('2d');
    if (ctx) ctx.drawImage(bitmap, tile.x, tile.y);
  } finally {
    bitmap.close();
  }
}

// --- Keyboard scancode mapping ---
// Maps KeyboardEvent.code to Linux evdev scancodes

function codeToScancode(code: string): number {
  const map: Record<string, number> = {
    Escape: 1,
    Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6,
    Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
    Minus: 12, Equal: 13, Backspace: 14, Tab: 15,
    KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20,
    KeyY: 21, KeyU: 22, KeyI: 23, KeyO: 24, KeyP: 25,
    BracketLeft: 26, BracketRight: 27, Enter: 28,
    ControlLeft: 29,
    KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34,
    KeyH: 35, KeyJ: 36, KeyK: 37, KeyL: 38,
    Semicolon: 39, Quote: 40, Backquote: 41,
    ShiftLeft: 42, Backslash: 43,
    KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48,
    KeyN: 49, KeyM: 50, Comma: 51, Period: 52, Slash: 53,
    ShiftRight: 54, NumpadMultiply: 55,
    AltLeft: 56, Space: 57, CapsLock: 58,
    F1: 59, F2: 60, F3: 61, F4: 62, F5: 63,
    F6: 64, F7: 65, F8: 66, F9: 67, F10: 68,
    NumLock: 69, ScrollLock: 70,
    Numpad7: 71, Numpad8: 72, Numpad9: 73, NumpadSubtract: 74,
    Numpad4: 75, Numpad5: 76, Numpad6: 77, NumpadAdd: 78,
    Numpad1: 79, Numpad2: 80, Numpad3: 81,
    Numpad0: 82, NumpadDecimal: 83,
    F11: 87, F12: 88,
    NumpadEnter: 96, ControlRight: 97,
    NumpadDivide: 98, PrintScreen: 99, AltRight: 100,
    Home: 102, ArrowUp: 103, PageUp: 104,
    ArrowLeft: 105, ArrowRight: 106,
    End: 107, ArrowDown: 108, PageDown: 109,
    Insert: 110, Delete: 111,
    MetaLeft: 125, MetaRight: 126,
    ContextMenu: 127,
  };

  return map[code] || 0;
}
