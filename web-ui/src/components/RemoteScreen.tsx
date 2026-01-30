import { useEffect, useRef, useCallback, useState, type ReactElement, type MutableRefObject } from 'react';
import { useWebRTC } from '../hooks/useWebRTC';
import type { ConnectionState } from '../hooks/useWebRTC';
import { FrameDecoder } from '../lib/FrameDecoder';

export interface RemoteScreenProps {
  deviceId: string | null;
  signalingUrl: string;
  onConnectionStateChange?: (state: ConnectionState) => void;
  disconnectRef?: MutableRefObject<(() => void) | null>;
}

const LONG_PRESS_DELAY = 500;
const SWIPE_THRESHOLD = 10; // pixels

// Android key codes
const KEYCODE_HOME = 3;
const KEYCODE_BACK = 4;
const KEYCODE_ENTER = 66;
const KEYCODE_DEL = 67; // Backspace
const KEYCODE_TAB = 61;
const KEYCODE_FORWARD_DEL = 112; // Delete
const KEYCODE_APP_SWITCH = 187;
const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_LEFT = 21;
const KEYCODE_DPAD_RIGHT = 22;

export function RemoteScreen({
  deviceId,
  signalingUrl,
  onConnectionStateChange,
  disconnectRef,
}: RemoteScreenProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const decoderRef = useRef<FrameDecoder | null>(null);
  const [videoDimensions, setVideoDimensions] = useState<{ width: number; height: number } | null>(null);

  // Touch state
  const pointerStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const isLongPressRef = useRef(false);

  const { connectionState, dataChannel, error, sendCommand, disconnect } = useWebRTC(deviceId, signalingUrl);

  // Expose disconnect to parent via ref
  useEffect(() => {
    if (disconnectRef) {
      disconnectRef.current = disconnect;
    }
    return () => {
      if (disconnectRef) {
        disconnectRef.current = null;
      }
    };
  }, [disconnect, disconnectRef]);

  // Notify parent of connection state changes
  useEffect(() => {
    onConnectionStateChange?.(connectionState);
  }, [connectionState, onConnectionStateChange]);

  // Set up frame decoder and data channel listener
  useEffect(() => {
    if (!canvasRef.current) {
      console.warn('[RemoteScreen] useEffect: canvas not available, skipping setup');
      return;
    }

    // Initialize decoder
    if (!decoderRef.current) {
      const decoder = new FrameDecoder(canvasRef.current);
      decoder.onDimensionsChanged = (w, h) => setVideoDimensions({ width: w, height: h });
      decoderRef.current = decoder;
      console.log('[RemoteScreen] FrameDecoder created');
    }

    // Listen for video frames on data channel
    if (dataChannel) {
      console.log('[RemoteScreen] Setting up data channel message handler, readyState:', dataChannel.readyState);
      let frameCount = 0;
      dataChannel.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          frameCount++;
          if (frameCount === 1 || frameCount % 100 === 0) {
            console.log(`[RemoteScreen] Video frame #${frameCount}, size: ${event.data.byteLength} bytes`);
          }
          decoderRef.current?.decode(event.data);
        } else {
          // Text message (command ACK)
          console.log('[RemoteScreen] Text message (ACK?):', event.data);
        }
      };
    } else {
      console.warn('[RemoteScreen] useEffect: dataChannel is null');
    }

    return () => {
      decoderRef.current?.destroy();
      decoderRef.current = null;
    };
  }, [dataChannel]);

  // Reset decoder when reconnecting
  useEffect(() => {
    if (connectionState === 'connecting') {
      decoderRef.current?.reset();
    }
  }, [connectionState]);

  const getNormalizedCoordinates = useCallback((clientX: number, clientY: number) => {
    if (!canvasRef.current) return { x: 0, y: 0 };

    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / rect.width,
      y: (clientY - rect.top) / rect.height,
    };
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    console.log(`[RemoteScreen] pointerDown: client=(${e.clientX.toFixed(0)}, ${e.clientY.toFixed(0)})`);
    const coords = getNormalizedCoordinates(e.clientX, e.clientY);
    pointerStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      time: Date.now(),
    };
    isLongPressRef.current = false;

    // Start long press timer
    longPressTimerRef.current = window.setTimeout(() => {
      isLongPressRef.current = true;
      sendCommand({
        type: 'LONG_PRESS',
        x: coords.x,
        y: coords.y,
      });
    }, LONG_PRESS_DELAY);
  }, [getNormalizedCoordinates, sendCommand]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!pointerStartRef.current) return;

    const dx = e.clientX - pointerStartRef.current.x;
    const dy = e.clientY - pointerStartRef.current.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Cancel long press if moving
    if (distance > SWIPE_THRESHOLD && longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    // Clear long press timer
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }

    if (!pointerStartRef.current || isLongPressRef.current) {
      pointerStartRef.current = null;
      return;
    }

    const startCoords = getNormalizedCoordinates(
      pointerStartRef.current.x,
      pointerStartRef.current.y
    );
    const endCoords = getNormalizedCoordinates(e.clientX, e.clientY);

    const dx = e.clientX - pointerStartRef.current.x;
    const dy = e.clientY - pointerStartRef.current.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance > SWIPE_THRESHOLD) {
      // Swipe
      console.log(`[RemoteScreen] SWIPE: (${startCoords.x.toFixed(3)},${startCoords.y.toFixed(3)}) -> (${endCoords.x.toFixed(3)},${endCoords.y.toFixed(3)}), dist=${distance.toFixed(1)}`);
      sendCommand({
        type: 'SWIPE',
        startX: startCoords.x,
        startY: startCoords.y,
        endX: endCoords.x,
        endY: endCoords.y,
      });
    } else {
      // Tap
      console.log(`[RemoteScreen] TAP: normalized=(${startCoords.x.toFixed(3)}, ${startCoords.y.toFixed(3)}), dist=${distance.toFixed(1)}`);
      sendCommand({
        type: 'TAP',
        x: startCoords.x,
        y: startCoords.y,
      });
    }

    pointerStartRef.current = null;
  }, [getNormalizedCoordinates, sendCommand]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Map special keys to Android key codes
    const keyMap: Record<string, number> = {
      Escape: KEYCODE_BACK,
      Backspace: KEYCODE_DEL,
      Enter: KEYCODE_ENTER,
      Tab: KEYCODE_TAB,
      Delete: KEYCODE_FORWARD_DEL,
      ArrowUp: KEYCODE_DPAD_UP,
      ArrowDown: KEYCODE_DPAD_DOWN,
      ArrowLeft: KEYCODE_DPAD_LEFT,
      ArrowRight: KEYCODE_DPAD_RIGHT,
    };

    // Ctrl+H → Home
    if (e.key === 'h' && e.ctrlKey) {
      e.preventDefault();
      sendCommand({ type: 'KEY_PRESS', keyCode: KEYCODE_HOME });
      return;
    }

    // Special keys → KEY_PRESS
    const mappedKeyCode = keyMap[e.key];
    if (mappedKeyCode !== undefined) {
      e.preventDefault();
      sendCommand({ type: 'KEY_PRESS', keyCode: mappedKeyCode });
      return;
    }

    // Printable characters → TYPE_TEXT (ignore modifier-only keys and ctrl/meta combos)
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      sendCommand({ type: 'TYPE_TEXT', text: e.key });
    }
  }, [sendCommand]);

  const handleNavButton = useCallback((keyCode: number) => {
    sendCommand({ type: 'KEY_PRESS', keyCode });
  }, [sendCommand]);

  const handleTripleTap = useCallback(() => {
    sendCommand({ type: 'MULTI_TAP', x: 0.5, y: 0.5, count: 3, intervalMs: 100 });
  }, [sendCommand]);

  // Render based on connection state
  if (!deviceId) {
    return (
      <div className="remote-screen remote-screen--empty">
        <p>No device selected</p>
      </div>
    );
  }

  if (connectionState === 'connecting') {
    return (
      <div className="remote-screen remote-screen--connecting">
        <div className="spinner" />
        <p>Connecting to device...</p>
      </div>
    );
  }

  if (connectionState === 'failed') {
    return (
      <div className="remote-screen remote-screen--error">
        <p>Connection failed</p>
        {error && <p className="error-message">{error}</p>}
      </div>
    );
  }

  if (connectionState === 'disconnected') {
    return (
      <div className="remote-screen remote-screen--disconnected">
        <p>Disconnected from device</p>
      </div>
    );
  }

  // Determine aspect ratio and max size from video dimensions
  const isLandscape = videoDimensions ? videoDimensions.width > videoDimensions.height : false;
  const aspectRatio = videoDimensions
    ? `${videoDimensions.width}/${videoDimensions.height}`
    : '9/16'; // Default portrait until dimensions are known

  return (
    <div className="remote-screen remote-screen--connected">
      <canvas
        ref={canvasRef}
        data-testid="video-canvas"
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onKeyDown={handleKeyDown}
        style={{
          width: '100%',
          maxWidth: isLandscape ? '800px' : '400px',
          maxHeight: '80vh',
          aspectRatio,
          backgroundColor: '#000',
          outline: 'none',
          cursor: 'pointer',
          objectFit: 'contain',
        }}
      />
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          gap: '24px',
          padding: '12px 0',
          maxWidth: isLandscape ? '800px' : '400px',
          width: '100%',
        }}
      >
        <button
          onClick={() => handleNavButton(KEYCODE_BACK)}
          title="Back"
          style={{
            background: 'none',
            border: '1px solid #444',
            borderRadius: '8px',
            color: '#ccc',
            padding: '8px 20px',
            cursor: 'pointer',
            fontSize: '18px',
            lineHeight: 1,
          }}
          aria-label="Back"
        >
          &#9664;
        </button>
        <button
          onClick={() => handleNavButton(KEYCODE_HOME)}
          title="Home"
          style={{
            background: 'none',
            border: '1px solid #444',
            borderRadius: '50%',
            color: '#ccc',
            width: '42px',
            height: '42px',
            cursor: 'pointer',
            fontSize: '14px',
            lineHeight: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          aria-label="Home"
        >
          &#9679;
        </button>
        <button
          onClick={() => handleNavButton(KEYCODE_APP_SWITCH)}
          title="Overview"
          style={{
            background: 'none',
            border: '1px solid #444',
            borderRadius: '8px',
            color: '#ccc',
            padding: '8px 20px',
            cursor: 'pointer',
            fontSize: '18px',
            lineHeight: 1,
          }}
          aria-label="Overview"
        >
          &#9632;
        </button>
        <button
          onClick={handleTripleTap}
          title="Triple Tap (center)"
          style={{
            background: 'none',
            border: '1px solid #444',
            borderRadius: '8px',
            color: '#ccc',
            padding: '8px 12px',
            cursor: 'pointer',
            fontSize: '12px',
            lineHeight: 1,
          }}
          aria-label="Triple Tap"
        >
          3x Tap
        </button>
      </div>
    </div>
  );
}
