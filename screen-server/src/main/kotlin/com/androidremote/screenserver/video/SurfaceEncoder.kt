package com.androidremote.screenserver.video

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Build
import android.view.Surface
import java.io.IOException
import java.io.OutputStream
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean

/**
 * H.264 encoder using MediaCodec's Surface input mode.
 *
 * Based on scrcpy's SurfaceEncoder.java - uses createInputSurface()
 * for direct Surface-to-encoder pipeline.
 */
class SurfaceEncoder(
    private val capture: ScreenCapture,
    private val output: OutputStream,
    private val bitRate: Int = 8_000_000,
    private val maxFps: Float = 60f
) {
    companion object {
        private const val MIME_TYPE = "video/avc" // H.264
        private const val I_FRAME_INTERVAL = 10 // seconds
        private const val REPEAT_FRAME_DELAY_US = 100_000L // 100ms
        private const val MAX_CONSECUTIVE_ERRORS = 3

        /**
         * Maximum time to wait for the first real (non-config) frame.
         * If SurfaceControl fails to render content to the encoder surface,
         * the encode loop will exit after this timeout instead of hanging forever.
         */
        private const val FIRST_FRAME_TIMEOUT_MS = 5_000L

        // Fallback sizes in descending order
        private val MAX_SIZE_FALLBACK = intArrayOf(2560, 1920, 1600, 1280, 1024, 800)
    }

    private val stopped = AtomicBoolean(false)
    private var firstFrameSent = false
    private var consecutiveErrors = 0
    private var triedPhysicalSize = false

    /**
     * Start encoding. This blocks until stopped or error.
     */
    fun encode() {
        val codec = createMediaCodec()
        val format = createMediaFormat()

        try {
            var alive = true
            var headerWritten = false

            while (alive && !stopped.get()) {
                capture.prepare()
                val size = capture.getSize()

                if (!headerWritten) {
                    writeHeader(size)
                    headerWritten = true
                }

                format.setInteger(MediaFormat.KEY_WIDTH, size.width)
                format.setInteger(MediaFormat.KEY_HEIGHT, size.height)

                var surface: Surface? = null
                var codecStarted = false
                var captureStarted = false

                try {
                    codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                    surface = codec.createInputSurface()

                    capture.start(surface)
                    captureStarted = true

                    codec.start()
                    codecStarted = true

                    if (stopped.get()) {
                        alive = false
                    } else {
                        encodeLoop(codec)
                        alive = !stopped.get()
                    }
                } catch (e: Exception) {
                    if (isBrokenPipe(e)) {
                        throw e
                    }
                    System.err.println("Capture/encoding error: ${e.javaClass.simpleName}: ${e.message}")
                    e.printStackTrace(System.err)
                    if (!prepareRetry(size)) {
                        throw e
                    }
                    alive = true
                } finally {
                    if (captureStarted) {
                        // Don't call capture.stop() - just release resources at end
                    }
                    if (codecStarted) {
                        try {
                            codec.stop()
                        } catch (e: IllegalStateException) {
                            // ignore
                        }
                    }
                    codec.reset()
                    surface?.release()
                }
            }
        } finally {
            codec.release()
            capture.release()
        }
    }

    /**
     * Stop encoding.
     */
    fun stop() {
        stopped.set(true)
    }

    private fun encodeLoop(codec: MediaCodec) {
        val bufferInfo = MediaCodec.BufferInfo()
        val loopStartTime = System.currentTimeMillis()

        while (!stopped.get()) {
            val outputBufferId = codec.dequeueOutputBuffer(bufferInfo, 10_000) // 10ms timeout

            if (outputBufferId >= 0) {
                try {
                    val eos = (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0

                    if (bufferInfo.size > 0) {
                        val codecBuffer = codec.getOutputBuffer(outputBufferId)!!

                        val isConfig = (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0
                        if (!isConfig) {
                            firstFrameSent = true
                            consecutiveErrors = 0
                        }

                        writePacket(codecBuffer, bufferInfo)
                    }

                    if (eos) {
                        return
                    }
                } finally {
                    codec.releaseOutputBuffer(outputBufferId, false)
                }
            }

            // Timeout: if no real frame produced within the deadline, abort.
            // This prevents the server from getting stuck when SurfaceControl
            // fails to render content (e.g. on some Rockchip devices).
            if (!firstFrameSent) {
                val elapsed = System.currentTimeMillis() - loopStartTime
                if (elapsed > FIRST_FRAME_TIMEOUT_MS) {
                    System.err.println("No video frames produced after ${elapsed}ms — SurfaceControl may not be rendering")
                    throw IOException("Timed out waiting for first video frame from SurfaceControl")
                }
            }
        }
    }

    private fun prepareRetry(currentSize: Size): Boolean {
        if (firstFrameSent) {
            consecutiveErrors++
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                return false
            }
            Thread.sleep(50)
            return true
        }

        // First retry: try physical dimensions (SurfaceFlinger may use physical
        // coordinate space on some devices like Rockchip)
        if (!triedPhysicalSize) {
            triedPhysicalSize = true
            capture.enablePhysicalSize()
            System.err.println("Retrying with physical display dimensions...")
            return true
        }

        // Subsequent retries: try smaller sizes
        val newMaxSize = chooseMaxSizeFallback(currentSize)
        if (newMaxSize == 0) {
            return false
        }

        val accepted = capture.setMaxSize(newMaxSize)
        if (!accepted) {
            return false
        }

        System.err.println("Retrying with max size $newMaxSize...")
        return true
    }

    private fun chooseMaxSizeFallback(failedSize: Size): Int {
        val currentMaxSize = maxOf(failedSize.width, failedSize.height)
        for (value in MAX_SIZE_FALLBACK) {
            if (value < currentMaxSize) {
                return value
            }
        }
        return 0
    }

    private fun createMediaCodec(): MediaCodec {
        return try {
            val codec = MediaCodec.createEncoderByType(MIME_TYPE)
            System.err.println("Using encoder: ${codec.name}")
            codec
        } catch (e: IOException) {
            throw RuntimeException("Could not create H.264 encoder", e)
        }
    }

    private fun createMediaFormat(): MediaFormat {
        return MediaFormat().apply {
            setString(MediaFormat.KEY_MIME, MIME_TYPE)
            setInteger(MediaFormat.KEY_BIT_RATE, bitRate)
            setInteger(MediaFormat.KEY_FRAME_RATE, 60)
            setInteger(
                MediaFormat.KEY_COLOR_FORMAT,
                MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface
            )
            if (Build.VERSION.SDK_INT >= 24) {
                setInteger(MediaFormat.KEY_COLOR_RANGE, MediaFormat.COLOR_RANGE_LIMITED)
            }
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, I_FRAME_INTERVAL)
            setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, REPEAT_FRAME_DELAY_US)

            if (maxFps > 0) {
                setFloat("max-fps-to-encoder", maxFps)
            }
        }
    }

    /**
     * Write stream header (size info).
     * Format: 4 bytes width + 4 bytes height (big endian)
     */
    private fun writeHeader(size: Size) {
        val header = ByteBuffer.allocate(8)
        header.putInt(size.width)
        header.putInt(size.height)
        output.write(header.array())
        output.flush()
    }

    /**
     * Write a packet to the output stream.
     * Format: 4 bytes size + 1 byte flags + data
     */
    private fun writePacket(buffer: ByteBuffer, info: MediaCodec.BufferInfo) {
        val size = info.size
        val data = ByteArray(size)
        buffer.get(data)

        // Packet format: [size:4][flags:1][data:size]
        val packet = ByteBuffer.allocate(5 + size)
        packet.putInt(size)
        packet.put(getFlags(info).toByte())
        packet.put(data)

        output.write(packet.array())

        // Flush config and keyframes immediately to ensure the client receives
        // them promptly. Regular frames batch for efficiency.
        val isConfig = (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0
        val isKeyFrame = (info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0
        if (isConfig || isKeyFrame) {
            output.flush()
        }
    }

    private fun getFlags(info: MediaCodec.BufferInfo): Int {
        var flags = 0
        if ((info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0) {
            flags = flags or 0x01 // Key frame flag
        }
        if ((info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
            flags = flags or 0x02 // Config flag
        }
        return flags
    }

    private fun isBrokenPipe(e: Exception): Boolean {
        var cause: Throwable? = e
        while (cause != null) {
            if (cause is IOException && cause.message?.contains("Broken pipe") == true) {
                return true
            }
            cause = cause.cause
        }
        return false
    }
}
