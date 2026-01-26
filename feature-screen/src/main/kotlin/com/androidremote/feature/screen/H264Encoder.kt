package com.androidremote.feature.screen

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.view.Surface
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.callbackFlow
import java.util.concurrent.atomic.AtomicBoolean

/**
 * H.264 video encoder wrapper using Android MediaCodec.
 *
 * Uses Surface input mode for efficient encoding of screen capture content.
 * The VirtualDisplay renders directly to the encoder's input surface,
 * avoiding extra buffer copies.
 *
 * Usage:
 * 1. Create encoder instance
 * 2. Call configure() with encoding parameters
 * 3. Get input surface via getInputSurface()
 * 4. Create VirtualDisplay rendering to the input surface
 * 5. Call start() to begin encoding
 * 6. Collect encoded frames from encodedFrames flow
 * 7. Call stop() when done
 * 8. Call release() to free resources
 */
class H264Encoder {

    private var codec: MediaCodec? = null
    private var inputSurface: Surface? = null
    private var encoderThread: HandlerThread? = null
    private var encoderHandler: Handler? = null
    private val isRunning = AtomicBoolean(false)
    private val isConfigured = AtomicBoolean(false)
    private var currentConfig: EncoderConfig? = null

    // Channel for encoded frames - buffered to handle bursts
    private var frameChannel: Channel<EncodedFrame>? = null

    /**
     * Flow of encoded frames from the encoder.
     *
     * This flow emits EncodedFrame objects as they are produced by MediaCodec.
     * The flow is active only while the encoder is running.
     */
    val encodedFrames: Flow<EncodedFrame> = callbackFlow {
        val channel = Channel<EncodedFrame>(Channel.BUFFERED)
        frameChannel = channel

        // Forward frames from internal channel to flow
        for (frame in channel) {
            send(frame)
        }

        awaitClose {
            frameChannel = null
        }
    }.buffer(Channel.BUFFERED)

    /**
     * Configures the encoder with the specified parameters.
     *
     * Must be called before start(). Creates the MediaCodec instance
     * and configures it for Surface input mode.
     *
     * @param config Encoder configuration (resolution, bitrate, etc.)
     * @throws IllegalStateException if already configured
     */
    fun configure(config: EncoderConfig) {
        check(!isConfigured.get()) { "Encoder already configured. Call release() first." }

        Log.d(TAG, "Configuring encoder: ${config.width}x${config.height} @ ${config.bitrate}bps")

        // Create and start handler thread for encoder callbacks
        encoderThread = HandlerThread("H264EncoderThread").apply {
            start()
            encoderHandler = Handler(looper)
        }

        // Create MediaFormat for H.264 encoding
        val format = MediaFormat.createVideoFormat(
            config.mimeType,
            config.width,
            config.height
        ).apply {
            setInteger(MediaFormat.KEY_BIT_RATE, config.bitrate)
            setInteger(MediaFormat.KEY_FRAME_RATE, config.frameRate)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, config.iFrameIntervalSeconds)
            setInteger(
                MediaFormat.KEY_COLOR_FORMAT,
                MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface
            )

            // Enable low latency mode if available (API 30+)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
            }

            // Set bitrate mode to VBR for better quality
            setInteger(
                MediaFormat.KEY_BITRATE_MODE,
                MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR
            )
        }

        // Create encoder
        codec = MediaCodec.createEncoderByType(config.mimeType)
        codec?.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)

        // Get input surface for VirtualDisplay to render to
        inputSurface = codec?.createInputSurface()

        currentConfig = config
        isConfigured.set(true)

        Log.d(TAG, "Encoder configured successfully")
    }

    /**
     * Returns the input Surface for rendering.
     *
     * The VirtualDisplay should render to this surface. The encoder
     * will encode frames as they are rendered.
     *
     * @return Input surface for rendering
     * @throws IllegalStateException if not configured
     */
    fun getInputSurface(): Surface {
        check(isConfigured.get()) { "Encoder not configured. Call configure() first." }
        return inputSurface ?: throw IllegalStateException("Input surface not available")
    }

    /**
     * Starts the encoder.
     *
     * After calling this, frames rendered to the input surface will be encoded
     * and emitted via the encodedFrames flow.
     *
     * @throws IllegalStateException if not configured or already running
     */
    fun start() {
        check(isConfigured.get()) { "Encoder not configured. Call configure() first." }
        check(!isRunning.get()) { "Encoder already running" }

        Log.d(TAG, "Starting encoder")

        val encoder = codec ?: throw IllegalStateException("Codec not available")
        val handler = encoderHandler ?: throw IllegalStateException("Handler not available")

        // Set up async callback for output buffers
        encoder.setCallback(object : MediaCodec.Callback() {
            override fun onInputBufferAvailable(codec: MediaCodec, index: Int) {
                // Not used in Surface mode - input comes from Surface
            }

            override fun onOutputBufferAvailable(
                codec: MediaCodec,
                index: Int,
                info: MediaCodec.BufferInfo
            ) {
                if (!isRunning.get()) return

                try {
                    processOutputBuffer(codec, index, info)
                } catch (e: Exception) {
                    Log.e(TAG, "Error processing output buffer", e)
                }
            }

            override fun onError(codec: MediaCodec, e: MediaCodec.CodecException) {
                Log.e(TAG, "MediaCodec error: ${e.diagnosticInfo}", e)
            }

            override fun onOutputFormatChanged(codec: MediaCodec, format: MediaFormat) {
                Log.d(TAG, "Output format changed: $format")
            }
        }, handler)

        encoder.start()
        isRunning.set(true)

        Log.d(TAG, "Encoder started")
    }

    /**
     * Processes an output buffer from MediaCodec.
     */
    private fun processOutputBuffer(
        codec: MediaCodec,
        index: Int,
        info: MediaCodec.BufferInfo
    ) {
        try {
            // Skip codec config data (SPS/PPS) - it's not a frame
            if ((info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                codec.releaseOutputBuffer(index, false)
                return
            }

            // Get output buffer
            val buffer = codec.getOutputBuffer(index) ?: run {
                codec.releaseOutputBuffer(index, false)
                return
            }

            // Copy data from buffer
            val data = ByteArray(info.size)
            buffer.position(info.offset)
            buffer.limit(info.offset + info.size)
            buffer.get(data)

            // Create encoded frame
            val frame = EncodedFrame.fromBufferInfo(
                data = data,
                presentationTimeUs = info.presentationTimeUs,
                flags = info.flags
            )

            // Send to channel (non-blocking)
            frameChannel?.trySend(frame)

            // Release the buffer back to codec
            codec.releaseOutputBuffer(index, false)

        } catch (e: Exception) {
            Log.e(TAG, "Error processing output buffer at index $index", e)
            try {
                codec.releaseOutputBuffer(index, false)
            } catch (releaseError: Exception) {
                Log.e(TAG, "Error releasing buffer", releaseError)
            }
        }
    }

    /**
     * Requests a key frame (I-frame) from the encoder.
     *
     * Useful when a new client connects and needs a key frame
     * to start decoding.
     */
    fun requestKeyFrame() {
        if (!isRunning.get()) return

        try {
            val params = android.os.Bundle().apply {
                putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0)
            }
            codec?.setParameters(params)
            Log.d(TAG, "Key frame requested")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to request key frame", e)
        }
    }

    /**
     * Stops the encoder.
     *
     * Encoded frames will no longer be emitted after this call.
     * The encoder can be started again with start().
     */
    fun stop() {
        if (!isRunning.getAndSet(false)) return

        Log.d(TAG, "Stopping encoder")

        try {
            codec?.stop()
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping codec", e)
        }

        Log.d(TAG, "Encoder stopped")
    }

    /**
     * Releases all encoder resources.
     *
     * Must be called when the encoder is no longer needed.
     * After release(), configure() must be called again before use.
     */
    fun release() {
        Log.d(TAG, "Releasing encoder resources")

        stop()

        // Close frame channel
        frameChannel?.close()
        frameChannel = null

        // Release input surface
        inputSurface?.release()
        inputSurface = null

        // Release codec
        try {
            codec?.release()
        } catch (e: Exception) {
            Log.e(TAG, "Error releasing codec", e)
        }
        codec = null

        // Stop handler thread
        encoderThread?.quitSafely()
        encoderThread = null
        encoderHandler = null

        currentConfig = null
        isConfigured.set(false)

        Log.d(TAG, "Encoder resources released")
    }

    /**
     * Returns true if the encoder is currently running.
     */
    fun isRunning(): Boolean = isRunning.get()

    /**
     * Returns true if the encoder is configured.
     */
    fun isConfigured(): Boolean = isConfigured.get()

    /**
     * Returns the current encoder configuration, or null if not configured.
     */
    fun getConfig(): EncoderConfig? = currentConfig

    companion object {
        private const val TAG = "H264Encoder"
    }
}
