import { useEffect, useRef, useCallback, useState, type ReactElement, type MutableRefObject } from 'react';
import { useWebRTC } from '../hooks/useWebRTC';
import type { ConnectionState } from '../hooks/useWebRTC';
import { FrameDecoder } from '../lib/FrameDecoder';
import { mapPointToContent } from '../lib/screenGeometry';

export interface RemoteScreenProps {
  deviceId: string | null;
  signalingUrl: string;
  onConnectionStateChange?: (state: ConnectionState) => void;
  disconnectRef?: MutableRefObject<(() => void) | null>;
}

const LONG_PRESS_DELAY = 500;
const SWIPE_THRESHOLD = 10; // pixels
const STALL_AFTER_MS = 3000;

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
  // Decoder / stall problems shown over the picture (WU-07)
  const [videoProblem, setVideoProblem] = useState<string | null>(null);
  const lastFrameAtRef = useRef(0);

  // Touch state
  const gestureRef = useRef<{ x: number; y: number; nx: number; ny: number } | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const isLongPressRef = useRef(false);

  const {
    connectionState, dataChannel, error, sendCommand, disconnect,
    screenInfo, captureError, subscribeVideo, requestKeyframe,
  } = useWebRTC(deviceId, signalingUrl);

  const requestKeyframeRef = useRef(requestKeyframe);
  useEffect(() => { requestKeyframeRef.current = requestKeyframe; }, [requestKeyframe]);

  // The device screen size (SCREEN_INFO, rotation aware) wins over the decoded size.
  const contentSize = screenInfo ?? videoDimensions;
  const contentSizeRef = useRef(contentSize);
  useEffect(() => { contentSizeRef.current = contentSize; }, [contentSize]);

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

  // Set up the frame decoder and subscribe to video from the hook. The hook owns the
  // data channel handlers and demultiplexes; nothing here overwrites onmessage.
  useEffect(() => {
    if (!canvasRef.current || !subscribeVideo) return;

    const decoder = new FrameDecoder(canvasRef.current);
    decoder.onDimensionsChanged = (w, h) => setVideoDimensions({ width: w, height: h });
    decoder.onError = (message) => setVideoProblem(message);
    decoder.onKeyframeNeeded = () => requestKeyframeRef.current?.();
    decoder.onFrameRendered = () => {
      lastFrameAtRef.current = Date.now();
      setVideoProblem(null);
    };
    decoderRef.current = decoder;
    lastFrameAtRef.current = Date.now();

    const unsubscribe = subscribeVideo((data) => decoder.decode(data));

    // Stall watchdog: frames stopped arriving although the connection says it is up.
    const watchdog = window.setInterval(() => {
      if (Date.now() - lastFrameAtRef.current > STALL_AFTER_MS) {
        setVideoProblem('Video stalled, requesting keyframe...');
        requestKeyframeRef.current?.();
      }
    }, 1000);

    return () => {
      window.clearInterval(watchdog);
      unsubscribe();
      decoder.destroy();
      decoderRef.current = null;
    };
  }, [dataChannel, connectionState, subscribeVideo]);

  // Reset decoder when reconnecting
  useEffect(() => {
    if (connectionState === 'connecting') {
      decoderRef.current?.reset();
    }
  }, [connectionState]);

  /** Map a client point onto the device screen, accounting for letterboxing. */
  const mapPoint = useCallback((clientX: number, clientY: number, clamp: boolean) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    return mapPointToContent(clientX, clientY, canvas.getBoundingClientRect(), contentSizeRef.current, clamp);
  }, []);

  const cancelGesture = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    gestureRef.current = null;
    isLongPressRef.current = false;
  }, []);

  // Never leave a long-press timer running after unmount
  useEffect(() => cancelGesture, [cancelGesture]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    cancelGesture();
    const start = mapPoint(e.clientX, e.clientY, false);
    if (!start || !start.inside) return; // presses in the letterbox bars are ignored

    // Keep receiving move/up even if the pointer leaves the canvas (WU-06)
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch { /* capture is best effort */ }

    gestureRef.current = { x: e.clientX, y: e.clientY, nx: start.x, ny: start.y };
    isLongPressRef.current = false;

    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      isLongPressRef.current = true;
      sendCommand({ type: 'LONG_PRESS', x: start.x, y: start.y });
    }, LONG_PRESS_DELAY);
  }, [mapPoint, cancelGesture, sendCommand]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (!g) return;

    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Cancel long press if moving
    if (distance > SWIPE_THRESHOLD && longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const g = gestureRef.current;
    const wasLongPress = isLongPressRef.current;
    cancelGesture();
    if (!g || wasLongPress) return;

    // The release may be outside the picture (pointer capture): clamp to the screen edge
    const end = mapPoint(e.clientX, e.clientY, true);
    if (!end) return;

    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance > SWIPE_THRESHOLD) {
      sendCommand({
        type: 'SWIPE',
        startX: g.nx,
        startY: g.ny,
        endX: end.x,
        endY: end.y,
      });
    } else {
      sendCommand({
        type: 'TAP',
        x: g.nx,
        y: g.ny,
      });
    }
  }, [mapPoint, cancelGesture, sendCommand]);

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

  // Determine aspect ratio and max size from the current device screen
  const isLandscape = contentSize ? contentSize.width > contentSize.height : false;
  const aspectRatio = contentSize
    ? `${contentSize.width}/${contentSize.height}`
    : '9/16'; // Default portrait until dimensions are known
  const problem = captureError
    ? `Screen capture failed on the device: ${captureError}`
    : videoProblem;

  return (
    <div className="remote-screen remote-screen--connected">
      <div
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: isLandscape ? '800px' : '400px',
        }}
      >
        <canvas
          ref={canvasRef}
          data-testid="video-canvas"
          tabIndex={0}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={cancelGesture}
          onLostPointerCapture={cancelGesture}
          onKeyDown={handleKeyDown}
          style={{
            width: '100%',
            maxHeight: '80vh',
            aspectRatio,
            backgroundColor: '#000',
            outline: 'none',
            cursor: 'pointer',
            objectFit: 'contain',
            touchAction: 'none',
            display: 'block',
          }}
        />
        {problem && (
          <div
            role="alert"
            className="remote-screen__problem"
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 0,
              padding: '8px 12px',
              background: 'rgba(160, 30, 30, 0.9)',
              color: '#fff',
              fontSize: '13px',
              pointerEvents: 'none',
            }}
          >
            {problem}
          </div>
        )}
      </div>
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
