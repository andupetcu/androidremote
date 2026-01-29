/**
 * H.264 NAL unit types relevant for decoding.
 */
const NAL_TYPE_IDR = 5;
const NAL_TYPE_SPS = 7;
const NAL_TYPE_PPS = 8;

/**
 * Decodes H.264 video frames received over WebRTC DataChannel.
 *
 * Frame format from Android VideoChannel:
 * - Byte 0: flags (bit 0 = keyframe)
 * - Bytes 1-8: presentation timestamp (big-endian microseconds)
 * - Bytes 9+: H.264 NAL unit data (Annex B format with start codes)
 *
 * The Android screen server sends SPS/PPS as a separate config packet
 * before the first IDR frame. This decoder buffers config data and
 * prepends it to keyframes so WebCodecs can decode the Annex B stream.
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

  /** Buffered SPS/PPS config data in Annex B format (with start codes). */
  private configData: Uint8Array | null = null;

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

    const view = new DataView(data);
    const isKeyFrame = (view.getUint8(0) & 0x01) !== 0;

    if (isKeyFrame) {
      const h264Data = new Uint8Array(data, 9);
      const nalTypes = this.getNalTypes(h264Data);
      const hasConfig = nalTypes.includes(NAL_TYPE_SPS) || nalTypes.includes(NAL_TYPE_PPS);
      const hasIdr = nalTypes.includes(NAL_TYPE_IDR);

      if (hasConfig) {
        // Extract and store SPS/PPS for later use
        this.configData = this.extractConfigNals(h264Data);
        console.log('FrameDecoder: stored SPS/PPS config data,', this.configData.length, 'bytes');
      }

      if (!hasIdr) {
        // Config-only packet (SPS/PPS without IDR slice) — don't decode
        return;
      }

      // Real keyframe with IDR — configure decoder if needed
      if (!this.configured) {
        const dims = this.parseSpsForDimensions(h264Data);
        this.configure(dims.width, dims.height);
      }
    }

    if (!this.configured) {
      // Queue non-keyframes until we get a keyframe to configure
      this.pendingFrames.push(data);
      return;
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

    // Frame data starts at byte 9 (H.264 Annex B)
    let frameData = new Uint8Array(data, 9);

    // For keyframes, ensure SPS/PPS is prepended (Annex B requires inline config)
    if (isKeyFrame && this.configData) {
      const nalTypes = this.getNalTypes(frameData);
      if (!nalTypes.includes(NAL_TYPE_SPS)) {
        // Prepend stored config data to make a complete Annex B keyframe
        const combined = new Uint8Array(this.configData.length + frameData.length);
        combined.set(this.configData, 0);
        combined.set(frameData, this.configData.length);
        frameData = combined;
      }
    }

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
   * Find all start code positions in Annex B data.
   * Returns array of {pos, len} where pos is the start code offset and
   * len is 3 (00 00 01) or 4 (00 00 00 01).
   */
  private findStartCodes(data: Uint8Array): Array<{ pos: number; len: number }> {
    const codes: Array<{ pos: number; len: number }> = [];
    let i = 0;
    while (i < data.length - 2) {
      if (data[i] === 0 && data[i + 1] === 0) {
        if (data[i + 2] === 1) {
          codes.push({ pos: i, len: 3 });
          i += 3;
        } else if (data[i + 2] === 0 && i + 3 < data.length && data[i + 3] === 1) {
          codes.push({ pos: i, len: 4 });
          i += 4;
        } else {
          i++;
        }
      } else {
        i++;
      }
    }
    return codes;
  }

  /**
   * Get NAL unit types present in Annex B data.
   */
  private getNalTypes(data: Uint8Array): number[] {
    const types: number[] = [];
    for (const sc of this.findStartCodes(data)) {
      const nalOffset = sc.pos + sc.len;
      if (nalOffset < data.length) {
        types.push(data[nalOffset] & 0x1f);
      }
    }
    return types;
  }

  /**
   * Extract SPS/PPS NAL units from Annex B data, preserving start codes.
   */
  private extractConfigNals(data: Uint8Array): Uint8Array {
    const startCodes = this.findStartCodes(data);
    const parts: Uint8Array[] = [];

    for (let i = 0; i < startCodes.length; i++) {
      const sc = startCodes[i];
      const nalOffset = sc.pos + sc.len;
      if (nalOffset >= data.length) continue;

      const nalType = data[nalOffset] & 0x1f;
      if (nalType === NAL_TYPE_SPS || nalType === NAL_TYPE_PPS) {
        const end = (i + 1 < startCodes.length) ? startCodes[i + 1].pos : data.length;
        parts.push(data.slice(sc.pos, end));
      }
    }

    if (parts.length === 0) return new Uint8Array(0);

    const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  }

  /**
   * Parse SPS NAL unit to extract video dimensions.
   * Falls back to 1920x1080 if parsing fails.
   */
  private parseSpsForDimensions(data: Uint8Array): { width: number; height: number } {
    const fallback = { width: 1920, height: 1080 };

    // Check stored config data first, then the frame data
    const source = this.configData ?? data;
    const startCodes = this.findStartCodes(source);

    for (let i = 0; i < startCodes.length; i++) {
      const sc = startCodes[i];
      const nalOffset = sc.pos + sc.len;
      if (nalOffset >= source.length) continue;

      const nalType = source[nalOffset] & 0x1f;
      if (nalType !== NAL_TYPE_SPS) continue;

      // SPS found — extract the NAL unit bytes (without start code)
      const end = (i + 1 < startCodes.length) ? startCodes[i + 1].pos : source.length;
      const sps = source.slice(nalOffset, end);

      try {
        return this.decodeSpsResolution(sps);
      } catch {
        console.warn('FrameDecoder: failed to parse SPS dimensions, using fallback');
        return fallback;
      }
    }

    return fallback;
  }

  /**
   * Minimal SPS parsing for width/height using Exp-Golomb decoding.
   */
  private decodeSpsResolution(sps: Uint8Array): { width: number; height: number } {
    // Skip forbidden_zero_bit (1), nal_ref_idc (2), nal_unit_type (5) = 1 byte
    const reader = new ExpGolombReader(sps, 8);

    const profileIdc = reader.readBits(8);
    reader.readBits(8); // constraint flags
    reader.readBits(8); // level_idc
    reader.readUE(); // seq_parameter_set_id

    // High profiles have additional chroma/scaling fields
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134].includes(profileIdc)) {
      const chromaFormatIdc = reader.readUE();
      if (chromaFormatIdc === 3) reader.readBits(1); // separate_colour_plane_flag
      reader.readUE(); // bit_depth_luma_minus8
      reader.readUE(); // bit_depth_chroma_minus8
      reader.readBits(1); // qpprime_y_zero_transform_bypass_flag
      const seqScalingMatrixPresent = reader.readBits(1);
      if (seqScalingMatrixPresent) {
        const limit = chromaFormatIdc !== 3 ? 8 : 12;
        for (let i = 0; i < limit; i++) {
          if (reader.readBits(1)) { // seq_scaling_list_present_flag
            skipScalingList(reader, i < 6 ? 16 : 64);
          }
        }
      }
    }

    reader.readUE(); // log2_max_frame_num_minus4
    const picOrderCntType = reader.readUE();
    if (picOrderCntType === 0) {
      reader.readUE(); // log2_max_pic_order_cnt_lsb_minus4
    } else if (picOrderCntType === 1) {
      reader.readBits(1); // delta_pic_order_always_zero_flag
      reader.readSE(); // offset_for_non_ref_pic
      reader.readSE(); // offset_for_top_to_bottom_field
      const numRefFrames = reader.readUE();
      for (let i = 0; i < numRefFrames; i++) reader.readSE();
    }

    reader.readUE(); // max_num_ref_frames
    reader.readBits(1); // gaps_in_frame_num_value_allowed_flag

    const picWidthInMbsMinus1 = reader.readUE();
    const picHeightInMapUnitsMinus1 = reader.readUE();
    const frameMbsOnly = reader.readBits(1);
    if (!frameMbsOnly) reader.readBits(1); // mb_adaptive_frame_field_flag

    reader.readBits(1); // direct_8x8_inference_flag

    let cropLeft = 0, cropRight = 0, cropTop = 0, cropBottom = 0;
    const frameCroppingFlag = reader.readBits(1);
    if (frameCroppingFlag) {
      cropLeft = reader.readUE();
      cropRight = reader.readUE();
      cropTop = reader.readUE();
      cropBottom = reader.readUE();
    }

    const width = (picWidthInMbsMinus1 + 1) * 16 - (cropLeft + cropRight) * 2;
    const height = (2 - frameMbsOnly) * (picHeightInMapUnitsMinus1 + 1) * 16 - (cropTop + cropBottom) * 2;

    console.log(`FrameDecoder: parsed SPS dimensions ${width}x${height}`);
    return { width, height };
  }

  /**
   * Reset the decoder state. Call when reconnecting.
   */
  reset(): void {
    if (this.decoder && this.decoder.state !== 'closed') {
      this.decoder.reset();
    }
    this.configured = false;
    this.configData = null;
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

/**
 * Exp-Golomb bitstream reader for H.264 SPS parsing.
 */
class ExpGolombReader {
  private data: Uint8Array;
  private bitOffset: number;

  constructor(data: Uint8Array, bitOffset = 0) {
    this.data = data;
    this.bitOffset = bitOffset;
  }

  readBits(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i++) {
      const byteIdx = (this.bitOffset >> 3);
      const bitIdx = 7 - (this.bitOffset & 7);
      if (byteIdx < this.data.length) {
        value = (value << 1) | ((this.data[byteIdx] >> bitIdx) & 1);
      }
      this.bitOffset++;
    }
    return value;
  }

  /** Read unsigned Exp-Golomb coded value. */
  readUE(): number {
    let zeros = 0;
    while (this.readBits(1) === 0 && zeros < 32) zeros++;
    if (zeros === 0) return 0;
    return (1 << zeros) - 1 + this.readBits(zeros);
  }

  /** Read signed Exp-Golomb coded value. */
  readSE(): number {
    const val = this.readUE();
    return (val & 1) ? ((val + 1) >> 1) : -(val >> 1);
  }
}

/** Skip a scaling list in SPS (needed for high-profile parsing). */
function skipScalingList(reader: ExpGolombReader, size: number): void {
  let lastScale = 8;
  let nextScale = 8;
  for (let j = 0; j < size; j++) {
    if (nextScale !== 0) {
      const delta = reader.readSE();
      nextScale = (lastScale + delta + 256) % 256;
    }
    lastScale = nextScale === 0 ? lastScale : nextScale;
  }
}
