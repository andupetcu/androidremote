/**
 * Decodes H.264 video frames received over WebRTC DataChannel.
 *
 * Frame format from Android VideoChannel:
 * - Byte 0: flags (bit 0 = keyframe)
 * - Bytes 1-8: presentation timestamp (big-endian microseconds)
 * - Bytes 9+: H.264 NAL unit data
 */
export class FrameDecoder {
  private decoder: VideoDecoder | null = null;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private configured = false;
  private pendingFrames: ArrayBuffer[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.initDecoder();
  }

  private initDecoder(): void {
    if (!('VideoDecoder' in window)) {
      console.error('WebCodecs VideoDecoder not supported');
      return;
    }

    this.decoder = new VideoDecoder({
      output: (frame) => this.renderFrame(frame),
      error: (e) => console.error('Decode error:', e),
    });
  }

  private configure(width: number, height: number): void {
    if (!this.decoder || this.configured) return;

    // Resize canvas to match video
    this.canvas.width = width;
    this.canvas.height = height;

    this.decoder.configure({
      codec: 'avc1.42E01F', // H.264 Baseline Profile Level 3.1
      optimizeForLatency: true,
    });

    this.configured = true;

    // Process any pending frames
    for (const frame of this.pendingFrames) {
      this.decodeFrame(frame);
    }
    this.pendingFrames = [];
  }

  /**
   * Decode a frame received from the data channel.
   */
  decode(data: ArrayBuffer): void {
    if (!this.decoder) return;

    // Configure on first keyframe if not already configured
    if (!this.configured) {
      const view = new DataView(data);
      const isKeyFrame = (view.getUint8(0) & 0x01) !== 0;

      if (isKeyFrame) {
        // Default to 720p, will be updated when we parse SPS
        this.configure(1280, 720);
      } else {
        // Queue non-keyframes until we get a keyframe
        this.pendingFrames.push(data);
        return;
      }
    }

    this.decodeFrame(data);
  }

  private decodeFrame(data: ArrayBuffer): void {
    if (!this.decoder || this.decoder.state === 'closed') return;

    const view = new DataView(data);

    // Parse header
    const flags = view.getUint8(0);
    const isKeyFrame = (flags & 0x01) !== 0;
    const timestamp = view.getBigUint64(1, false); // big-endian

    // Frame data starts at byte 9
    const frameData = data.slice(9);

    try {
      this.decoder.decode(new EncodedVideoChunk({
        type: isKeyFrame ? 'key' : 'delta',
        timestamp: Number(timestamp),
        data: frameData,
      }));
    } catch (e) {
      console.error('Failed to decode frame:', e);
    }
  }

  private renderFrame(frame: VideoFrame): void {
    // Update canvas size if needed
    if (this.canvas.width !== frame.displayWidth ||
        this.canvas.height !== frame.displayHeight) {
      this.canvas.width = frame.displayWidth;
      this.canvas.height = frame.displayHeight;
    }

    this.ctx.drawImage(frame, 0, 0);
    frame.close();
  }

  /**
   * Reset the decoder state. Call when reconnecting.
   */
  reset(): void {
    if (this.decoder && this.decoder.state !== 'closed') {
      this.decoder.reset();
    }
    this.configured = false;
    this.pendingFrames = [];
    this.initDecoder();
  }

  /**
   * Clean up resources.
   */
  destroy(): void {
    if (this.decoder && this.decoder.state !== 'closed') {
      this.decoder.close();
    }
    this.decoder = null;
  }
}
