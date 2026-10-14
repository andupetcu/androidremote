import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RemoteScreen } from '../components/RemoteScreen';

// Mock the useWebRTC hook
const mockSendCommand = vi.fn();
const mockUseWebRTC = vi.fn();

vi.mock('../hooks/useWebRTC', () => ({
  useWebRTC: (...args: unknown[]) => mockUseWebRTC(...args),
}));

// Replace the decoder so the tests can drive its callbacks.
const decoders: Array<{
  onError: ((m: string) => void) | null;
  onKeyframeNeeded: (() => void) | null;
  onFrameRendered: (() => void) | null;
  onDimensionsChanged: ((w: number, h: number) => void) | null;
  decode: ReturnType<typeof vi.fn>;
}> = [];
vi.mock('../lib/FrameDecoder', () => ({
  FrameDecoder: class {
    onError = null; onKeyframeNeeded = null; onFrameRendered = null; onDimensionsChanged = null;
    decode = vi.fn(); reset = vi.fn(); destroy = vi.fn();
    constructor() { decoders.push(this as never); }
  },
}));

const mockRequestKeyframe = vi.fn();
let videoListener: ((d: ArrayBuffer) => void) | null = null;
const mockSubscribeVideo = vi.fn((l: (d: ArrayBuffer) => void) => { videoListener = l; return () => { videoListener = null; }; });

function hookState(over: Record<string, unknown> = {}) {
  return {
    connectionState: 'connected',
    dataChannel: { onmessage: null },
    error: null,
    sendCommand: mockSendCommand,
    disconnect: vi.fn(),
    screenInfo: null,
    captureError: null,
    subscribeVideo: mockSubscribeVideo,
    requestKeyframe: mockRequestKeyframe,
    ...over,
  };
}

const rectOf = (left: number, top: number, width: number, height: number) => ({
  left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}),
});

describe('RemoteScreen', () => {
  beforeEach(() => {
    mockSendCommand.mockClear();
    mockRequestKeyframe.mockClear();
    decoders.length = 0;
    videoListener = null;
    mockUseWebRTC.mockReturnValue(hookState());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('Connection States', () => {
    it('shows empty state when no deviceId', () => {
      render(<RemoteScreen deviceId={null} signalingUrl="ws://test/ws" />);
      expect(screen.getByText(/no device selected/i)).toBeInTheDocument();
    });

    it('shows connecting state', () => {
      mockUseWebRTC.mockReturnValue({
        connectionState: 'connecting',
        dataChannel: null,
        error: null,
        sendCommand: mockSendCommand,
      });

      render(<RemoteScreen deviceId="device-123" signalingUrl="ws://test/ws" />);
      expect(screen.getByText(/connecting to device/i)).toBeInTheDocument();
    });

    it('shows error state with message', () => {
      mockUseWebRTC.mockReturnValue({
        connectionState: 'failed',
        dataChannel: null,
        error: 'Connection refused',
        sendCommand: mockSendCommand,
      });

      render(<RemoteScreen deviceId="device-123" signalingUrl="ws://test/ws" />);
      expect(screen.getByText(/connection failed/i)).toBeInTheDocument();
      expect(screen.getByText(/connection refused/i)).toBeInTheDocument();
    });

    it('shows disconnected state', () => {
      mockUseWebRTC.mockReturnValue({
        connectionState: 'disconnected',
        dataChannel: null,
        error: null,
        sendCommand: mockSendCommand,
      });

      render(<RemoteScreen deviceId="device-123" signalingUrl="ws://test/ws" />);
      expect(screen.getByText(/disconnected from device/i)).toBeInTheDocument();
    });

    it('displays canvas when connected', () => {
      render(<RemoteScreen deviceId="device-123" signalingUrl="ws://test/ws" />);
      expect(screen.getByTestId('video-canvas')).toBeInTheDocument();
      // Connected view has no status text; it shows the canvas plus nav buttons
      expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();
      expect(screen.queryByText(/connecting to device/i)).not.toBeInTheDocument();
    });

    it('notifies parent of connection state changes', () => {
      const onStateChange = vi.fn();

      render(
        <RemoteScreen
          deviceId="device-123"
          signalingUrl="ws://test/ws"
          onConnectionStateChange={onStateChange}
        />
      );

      expect(onStateChange).toHaveBeenCalledWith('connected');
    });
  });

  describe('Tap Interaction', () => {
    it('sends tap command on pointer down/up sequence', async () => {
      render(<RemoteScreen deviceId="device-123" signalingUrl="ws://test/ws" />);

      const canvas = screen.getByTestId('video-canvas');

      // Mock getBoundingClientRect
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
        left: 0, top: 0, width: 1000, height: 2000,
        right: 1000, bottom: 2000, x: 0, y: 0,
        toJSON: () => ({}),
      });

      // Simulate tap (quick pointer down/up)
      fireEvent.pointerDown(canvas, { clientX: 500, clientY: 1000, pointerId: 1 });
      fireEvent.pointerUp(canvas, { clientX: 500, clientY: 1000, pointerId: 1 });

      await waitFor(() => {
        expect(mockSendCommand).toHaveBeenCalledWith({
          type: 'TAP',
          x: 0.5,
          y: 0.5,
        });
      });
    });

    it('calculates normalized coordinates correctly', async () => {
      render(<RemoteScreen deviceId="device-123" signalingUrl="ws://test/ws" />);

      const canvas = screen.getByTestId('video-canvas');

      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
        left: 100, top: 200, width: 400, height: 800,
        right: 500, bottom: 1000, x: 100, y: 200,
        toJSON: () => ({}),
      });

      // Click at (300, 600) in viewport = (0.5, 0.5) normalized
      fireEvent.pointerDown(canvas, { clientX: 300, clientY: 600, pointerId: 1 });
      fireEvent.pointerUp(canvas, { clientX: 300, clientY: 600, pointerId: 1 });

      await waitFor(() => {
        expect(mockSendCommand).toHaveBeenCalledWith({
          type: 'TAP',
          x: 0.5,
          y: 0.5,
        });
      });
    });
  });

  describe('Tap Interaction (letterboxed canvas)', () => {
    // WU-05: coordinates are mapped against the drawn video content box, not the element rect
    it('maps taps relative to the rendered video area, not the whole canvas element', async () => {
      mockUseWebRTC.mockReturnValue(hookState({ screenInfo: { width: 1000, height: 1000, rotation: 0 } }));
      render(<RemoteScreen deviceId="device-123" signalingUrl="ws://test/ws" />);

      const canvas = screen.getByTestId('video-canvas') as HTMLCanvasElement;
      // Square video (1000x1000) letterboxed inside a 1000x2000 element:
      // video occupies y in [500, 1500].
      canvas.width = 1000;
      canvas.height = 1000;
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
        left: 0, top: 0, width: 1000, height: 2000,
        right: 1000, bottom: 2000, x: 0, y: 0,
        toJSON: () => ({}),
      });

      // Tap on the top edge of the video picture
      fireEvent.pointerDown(canvas, { clientX: 500, clientY: 500, pointerId: 1 });
      fireEvent.pointerUp(canvas, { clientX: 500, clientY: 500, pointerId: 1 });

      await waitFor(() => {
        expect(mockSendCommand).toHaveBeenCalledWith({ type: 'TAP', x: 0.5, y: 0 });
      });
    });
  });


  describe('Pointer mapping (WU-05, WU-06)', () => {
    it('maps taps in pillarboxed (side bars) content and rejects taps in the bars', () => {
      // 1000x500 landscape picture in a 1000x2000 box? no: a 500x1000 picture in 1000x1000 box
      mockUseWebRTC.mockReturnValue(hookState({ screenInfo: { width: 500, height: 1000, rotation: 0 } }));
      render(<RemoteScreen deviceId="d" signalingUrl="ws://t/ws" />);
      const canvas = screen.getByTestId('video-canvas');
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(rectOf(0, 0, 1000, 1000));
      // picture occupies x in [250, 750]
      fireEvent.pointerDown(canvas, { clientX: 750, clientY: 500, pointerId: 1 });
      fireEvent.pointerUp(canvas, { clientX: 750, clientY: 500, pointerId: 1 });
      expect(mockSendCommand).toHaveBeenCalledWith({ type: 'TAP', x: 1, y: 0.5 });
      mockSendCommand.mockClear();
      fireEvent.pointerDown(canvas, { clientX: 100, clientY: 500, pointerId: 2 });
      fireEvent.pointerUp(canvas, { clientX: 100, clientY: 500, pointerId: 2 });
      expect(mockSendCommand).not.toHaveBeenCalled();
    });

    it('rotation: SCREEN_INFO with rotation 90 changes the content box used for mapping', () => {
      // landscape 2000x1000 shown in a 1000x2000 element: content is 1000x500 at y in [750,1250]
      mockUseWebRTC.mockReturnValue(hookState({ screenInfo: { width: 2000, height: 1000, rotation: 90 } }));
      render(<RemoteScreen deviceId="d" signalingUrl="ws://t/ws" />);
      const canvas = screen.getByTestId('video-canvas');
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(rectOf(0, 0, 1000, 2000));
      fireEvent.pointerDown(canvas, { clientX: 250, clientY: 1000, pointerId: 1 });
      fireEvent.pointerUp(canvas, { clientX: 250, clientY: 1000, pointerId: 1 });
      expect(mockSendCommand).toHaveBeenCalledWith({ type: 'TAP', x: 0.25, y: 0.5 });
      // a tap above the picture is in the bar
      mockSendCommand.mockClear();
      fireEvent.pointerDown(canvas, { clientX: 500, clientY: 100, pointerId: 2 });
      fireEvent.pointerUp(canvas, { clientX: 500, clientY: 100, pointerId: 2 });
      expect(mockSendCommand).not.toHaveBeenCalled();
    });

    it('re-maps after the device rotates (SCREEN_INFO changes)', () => {
      mockUseWebRTC.mockReturnValue(hookState({ screenInfo: { width: 1000, height: 2000, rotation: 0 } }));
      const { rerender } = render(<RemoteScreen deviceId="d" signalingUrl="ws://t/ws" />);
      const canvas = screen.getByTestId('video-canvas');
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(rectOf(0, 0, 1000, 2000));
      fireEvent.pointerDown(canvas, { clientX: 500, clientY: 1000, pointerId: 1 });
      fireEvent.pointerUp(canvas, { clientX: 500, clientY: 1000, pointerId: 1 });
      expect(mockSendCommand).toHaveBeenLastCalledWith({ type: 'TAP', x: 0.5, y: 0.5 });
      mockUseWebRTC.mockReturnValue(hookState({ screenInfo: { width: 2000, height: 1000, rotation: 90 } }));
      rerender(<RemoteScreen deviceId="d" signalingUrl="ws://t/ws" />);
      fireEvent.pointerDown(canvas, { clientX: 1000, clientY: 750, pointerId: 1 });
      fireEvent.pointerUp(canvas, { clientX: 1000, clientY: 750, pointerId: 1 });
      expect(mockSendCommand).toHaveBeenLastCalledWith({ type: 'TAP', x: 1, y: 0 });
    });

    it('captures the pointer on press so a release outside the canvas is still delivered', () => {
      render(<RemoteScreen deviceId="d" signalingUrl="ws://t/ws" />);
      const canvas = screen.getByTestId('video-canvas') as HTMLCanvasElement;
      const capture = vi.fn();
      canvas.setPointerCapture = capture;
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(rectOf(0, 0, 1000, 2000));
      fireEvent.pointerDown(canvas, { clientX: 500, clientY: 1000, pointerId: 7 });
      expect(capture).toHaveBeenCalledWith(7);
      // released far outside the canvas: end point is clamped to the picture edge
      fireEvent.pointerUp(canvas, { clientX: 5000, clientY: 1000, pointerId: 7 });
      expect(mockSendCommand).toHaveBeenCalledWith({
        type: 'SWIPE', startX: 0.5, startY: 0.5, endX: 1, endY: 0.5,
      });
    });

    it('a cancelled/lost pointer does not fire a long press or leave a stale origin', () => {
      vi.useFakeTimers();
      render(<RemoteScreen deviceId="d" signalingUrl="ws://t/ws" />);
      const canvas = screen.getByTestId('video-canvas');
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(rectOf(0, 0, 1000, 2000));
      fireEvent.pointerDown(canvas, { clientX: 500, clientY: 1000, pointerId: 1 });
      fireEvent.pointerCancel(canvas, { pointerId: 1 });
      vi.advanceTimersByTime(900);
      expect(mockSendCommand).not.toHaveBeenCalled();
      // a stray pointerUp afterwards must not turn into a swipe from the stale origin
      fireEvent.pointerUp(canvas, { clientX: 100, clientY: 100, pointerId: 1 });
      expect(mockSendCommand).not.toHaveBeenCalled();

      fireEvent.pointerDown(canvas, { clientX: 500, clientY: 1000, pointerId: 2 });
      fireEvent.lostPointerCapture(canvas, { pointerId: 2 });
      vi.advanceTimersByTime(900);
      expect(mockSendCommand).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('disables browser touch gestures on the canvas', () => {
      render(<RemoteScreen deviceId="d" signalingUrl="ws://t/ws" />);
      expect(screen.getByTestId('video-canvas').style.touchAction).toBe('none');
    });
  });

  describe('Video health and capture errors (WU-07, C8, C9)', () => {
    it('shows the decoder error and asks the device for a keyframe', () => {
      render(<RemoteScreen deviceId="d" signalingUrl="ws://t/ws" />);
      act(() => decoders[0].onError?.('Decode error: corrupt NAL'));
      expect(screen.getByRole('alert')).toHaveTextContent(/corrupt NAL/);
      act(() => decoders[0].onKeyframeNeeded?.());
      expect(mockRequestKeyframe).toHaveBeenCalled();
    });

    it('clears the error once a frame renders again', () => {
      render(<RemoteScreen deviceId="d" signalingUrl="ws://t/ws" />);
      act(() => decoders[0].onError?.('Decode error: x'));
      expect(screen.getByRole('alert')).toBeInTheDocument();
      act(() => decoders[0].onFrameRendered?.());
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('shows "video stalled, requesting keyframe" when frames stop and requests one', () => {
      vi.useFakeTimers();
      render(<RemoteScreen deviceId="d" signalingUrl="ws://t/ws" />);
      act(() => decoders[0].onFrameRendered?.());
      act(() => { vi.advanceTimersByTime(5000); });
      expect(screen.getByRole('alert')).toHaveTextContent(/video stalled, requesting keyframe/i);
      expect(mockRequestKeyframe).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('shows the CAPTURE_FAILED reason instead of a black screen', () => {
      mockUseWebRTC.mockReturnValue(hookState({ captureError: 'MediaProjection permission revoked' }));
      render(<RemoteScreen deviceId="d" signalingUrl="ws://t/ws" />);
      expect(screen.getByRole('alert')).toHaveTextContent(/MediaProjection permission revoked/);
    });

    it('routes video chunks from the hook subscription to the decoder (no onmessage override)', () => {
      const dc = { onmessage: null as unknown };
      mockUseWebRTC.mockReturnValue(hookState({ dataChannel: dc }));
      render(<RemoteScreen deviceId="d" signalingUrl="ws://t/ws" />);
      expect(dc.onmessage).toBeNull();
      const buf = new ArrayBuffer(12);
      videoListener?.(buf);
      expect(decoders[0].decode).toHaveBeenCalledWith(buf);
    });
  });

  describe('Swipe Interaction', () => {
    it('sends swipe command on drag', async () => {
      render(<RemoteScreen deviceId="device-123" signalingUrl="ws://test/ws" />);

      const canvas = screen.getByTestId('video-canvas');

      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
        left: 0, top: 0, width: 1000, height: 2000,
        right: 1000, bottom: 2000, x: 0, y: 0,
        toJSON: () => ({}),
      });

      // Simulate swipe down (more than threshold distance)
      fireEvent.pointerDown(canvas, { clientX: 500, clientY: 400, pointerId: 1 });
      fireEvent.pointerMove(canvas, { clientX: 500, clientY: 800, pointerId: 1 });
      fireEvent.pointerUp(canvas, { clientX: 500, clientY: 800, pointerId: 1 });

      await waitFor(() => {
        expect(mockSendCommand).toHaveBeenCalledWith({
          type: 'SWIPE',
          startX: 0.5,
          startY: 0.2,
          endX: 0.5,
          endY: 0.4,
        });
      });
    });

    it('treats small movement as tap, not swipe', async () => {
      render(<RemoteScreen deviceId="device-123" signalingUrl="ws://test/ws" />);

      const canvas = screen.getByTestId('video-canvas');

      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
        left: 0, top: 0, width: 1000, height: 2000,
        right: 1000, bottom: 2000, x: 0, y: 0,
        toJSON: () => ({}),
      });

      // Small movement (< 10px threshold)
      fireEvent.pointerDown(canvas, { clientX: 500, clientY: 1000, pointerId: 1 });
      fireEvent.pointerMove(canvas, { clientX: 503, clientY: 1003, pointerId: 1 });
      fireEvent.pointerUp(canvas, { clientX: 503, clientY: 1003, pointerId: 1 });

      await waitFor(() => {
        expect(mockSendCommand).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'TAP' })
        );
      });
    });
  });

  describe('Long Press Interaction', () => {
    it('sends long press after hold duration', async () => {
      vi.useFakeTimers();

      render(<RemoteScreen deviceId="device-123" signalingUrl="ws://test/ws" />);

      const canvas = screen.getByTestId('video-canvas');

      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
        left: 0, top: 0, width: 1000, height: 2000,
        right: 1000, bottom: 2000, x: 0, y: 0,
        toJSON: () => ({}),
      });

      fireEvent.pointerDown(canvas, { clientX: 500, clientY: 1000, pointerId: 1 });

      // Advance past long press delay (500ms)
      vi.advanceTimersByTime(600);

      expect(mockSendCommand).toHaveBeenCalledWith({
        type: 'LONG_PRESS',
        x: 0.5,
        y: 0.5,
      });

      vi.useRealTimers();
    });

    it('cancels long press if pointer moves', async () => {
      vi.useFakeTimers();

      render(<RemoteScreen deviceId="device-123" signalingUrl="ws://test/ws" />);

      const canvas = screen.getByTestId('video-canvas');

      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
        left: 0, top: 0, width: 1000, height: 2000,
        right: 1000, bottom: 2000, x: 0, y: 0,
        toJSON: () => ({}),
      });

      fireEvent.pointerDown(canvas, { clientX: 500, clientY: 1000, pointerId: 1 });

      // Move pointer before long press triggers
      vi.advanceTimersByTime(200);
      fireEvent.pointerMove(canvas, { clientX: 500, clientY: 1100, pointerId: 1 });

      // Wait past threshold
      vi.advanceTimersByTime(400);

      // Should not have sent LONG_PRESS
      expect(mockSendCommand).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'LONG_PRESS' })
      );

      vi.useRealTimers();
    });
  });

  describe('Keyboard Input', () => {
    it('sends back key on Escape', () => {
      render(<RemoteScreen deviceId="device-123" signalingUrl="ws://test/ws" />);

      const canvas = screen.getByTestId('video-canvas');
      fireEvent.keyDown(canvas, { key: 'Escape' });

      expect(mockSendCommand).toHaveBeenCalledWith({
        type: 'KEY_PRESS',
        keyCode: 4, // KEYCODE_BACK
      });
    });

    it('sends home key on Ctrl+H', () => {
      render(<RemoteScreen deviceId="device-123" signalingUrl="ws://test/ws" />);

      const canvas = screen.getByTestId('video-canvas');
      fireEvent.keyDown(canvas, { key: 'h', ctrlKey: true });

      expect(mockSendCommand).toHaveBeenCalledWith({
        type: 'KEY_PRESS',
        keyCode: 3, // KEYCODE_HOME
      });
    });
  });

  describe('WebRTC Hook Integration', () => {
    it('passes correct deviceId and signalingUrl to hook', () => {
      render(
        <RemoteScreen
          deviceId="my-device"
          signalingUrl="ws://example.com/ws"
        />
      );

      expect(mockUseWebRTC).toHaveBeenCalledWith('my-device', 'ws://example.com/ws');
    });
  });
});
