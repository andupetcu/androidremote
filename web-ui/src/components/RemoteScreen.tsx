import { useEffect, useRef, useCallback, type ReactElement } from 'react';
import { useWebRTC } from '../hooks/useWebRTC';
import type { ConnectionState } from '../hooks/useWebRTC';
import { FrameDecoder } from '../lib/FrameDecoder';

export interface Command {
  type: 'TAP' | 'SWIPE' | 'LONG_PRESS' | 'KEY' | 'TEXT';
  x?: number;
  y?: number;
  startX?: number;
  startY?: number;
  endX?: number;
  endY?: number;
  code?: number;
  text?: string;
}

export interface RemoteScreenProps {
  deviceId: string | null;
  signalingUrl: string;
  onConnectionStateChange?: (state: ConnectionState) => void;
}

const LONG_PRESS_DELAY = 500;
const SWIPE_THRESHOLD = 10; // pixels

// Android key codes
const KEYCODE_HOME = 3;
const KEYCODE_BACK = 4;

export function RemoteScreen({
  deviceId,
  signalingUrl,
  onConnectionStateChange,
}: RemoteScreenProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const decoderRef = useRef<FrameDecoder | null>(null);

  // Touch state
  const pointerStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const isLongPressRef = useRef(false);

  const { connectionState, dataChannel, error, sendCommand } = useWebRTC(deviceId, signalingUrl);

  // Notify parent of connection state changes
  useEffect(() => {
    onConnectionStateChange?.(connectionState);
  }, [connectionState, onConnectionStateChange]);

  // Set up frame decoder and data channel listener
  useEffect(() => {
    if (!canvasRef.current) return;

    // Initialize decoder
    if (!decoderRef.current) {
      decoderRef.current = new FrameDecoder(canvasRef.current);
    }

    // Listen for video frames on data channel
    if (dataChannel) {
      dataChannel.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          decoderRef.current?.decode(event.data);
        }
      };
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
      sendCommand({
        type: 'SWIPE',
        startX: startCoords.x,
        startY: startCoords.y,
        endX: endCoords.x,
        endY: endCoords.y,
      });
    } else {
      // Tap
      sendCommand({
        type: 'TAP',
        x: startCoords.x,
        y: startCoords.y,
      });
    }

    pointerStartRef.current = null;
  }, [getNormalizedCoordinates, sendCommand]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    let keyCode: number | null = null;

    if (e.key === 'Escape') {
      keyCode = KEYCODE_BACK;
    } else if (e.key === 'h' && e.ctrlKey) {
      keyCode = KEYCODE_HOME;
      e.preventDefault();
    }

    if (keyCode !== null) {
      sendCommand({
        type: 'KEY',
        code: keyCode,
      });
    }
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
          maxWidth: '400px',
          aspectRatio: '9/16',
          backgroundColor: '#000',
          outline: 'none',
          cursor: 'pointer',
        }}
      />
      <p className="status">Connected</p>
    </div>
  );
}
