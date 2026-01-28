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
  private frameCount = 0;
  private lastFrameTime = 0;
  private webCodecsAvailable = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.initDecoder();
  }

  private initDecoder(): void {
    // Check secure context first
    if (!window.isSecureContext) {
      console.warn('WebCodecs requires secure context (HTTPS or localhost). Current origin:', window.location.origin);
      console.warn('To fix: access via http://localhost:5173 instead of IP address');
      this.showFallbackMessage('Secure context required for video.\nUse localhost instead of IP.');
      return;
    }

    if (!('VideoDecoder' in window)) {
      console.error('WebCodecs VideoDecoder not supported in this browser');
      this.showFallbackMessage('VideoDecoder not supported.\nUpdate your browser.');
      return;
    }

    this.webCodecsAvailable = true;
    this.decoder = new VideoDecoder({
      output: (frame) => this.renderFrame(frame),
      error: (e) => console.error('Decode error:', e),
    });
  }

  private showFallbackMessage(message: string): void {
    this.canvas.width = 400;
    this.canvas.height = 300;
    this.ctx.fillStyle = '#1a1a2e';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.fillStyle = '#ffffff';
    this.ctx.font = '14px monospace';
    this.ctx.textAlign = 'center';

    const lines = message.split('\n');
    lines.forEach((line, i) => {
      this.ctx.fillText(line, this.canvas.width / 2, 140 + i * 20);
    });
  }

  private showFrameStats(): void {
    // Show frame reception stats when WebCodecs isn't available
    const now = Date.now();
    const fps = this.lastFrameTime > 0 ? Math.round(1000 / (now - this.lastFrameTime)) : 0;
    this.lastFrameTime = now;

    this.ctx.fillStyle = '#1a1a2e';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.fillStyle = '#00ff00';
    this.ctx.font = '16px monospace';
    this.ctx.textAlign = 'center';
    this.ctx.fillText(`Frames received: ${this.frameCount}`, this.canvas.width / 2, 130);
    this.ctx.fillText(`~${fps} fps`, this.canvas.width / 2, 160);
    this.ctx.fillStyle = '#ffaa00';
    this.ctx.font = '12px monospace';
    this.ctx.fillText('Video arriving but decoder unavailable', this.canvas.width / 2, 200);
    this.ctx.fillText('Use http://localhost:5173 for video', this.canvas.width / 2, 220);
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
    this.frameCount++;

    // If WebCodecs not available, just show frame stats
    if (!this.webCodecsAvailable || !this.decoder) {
      this.showFrameStats();
      return;
    }

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
    this.frameCount = 0;
    this.lastFrameTime = 0;
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
