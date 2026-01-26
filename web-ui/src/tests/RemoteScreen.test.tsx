import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RemoteScreen } from '../components/RemoteScreen';

// Mock the useWebRTC hook
const mockSendCommand = vi.fn();
const mockUseWebRTC = vi.fn();

vi.mock('../hooks/useWebRTC', () => ({
  useWebRTC: (...args: unknown[]) => mockUseWebRTC(...args),
}));

describe('RemoteScreen', () => {
  beforeEach(() => {
    mockSendCommand.mockClear();
    mockUseWebRTC.mockReturnValue({
      connectionState: 'connected',
      dataChannel: { onmessage: null },
      error: null,
      sendCommand: mockSendCommand,
    });
  });

  afterEach(() => {
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
      expect(screen.getByText(/connected/i)).toBeInTheDocument();
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
