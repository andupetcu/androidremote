package com.androidremote.feature.screen

import android.content.Context
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.projection.MediaProjection
import android.os.Handler
import android.os.HandlerThread
import android.util.DisplayMetrics
import android.util.Log
import android.view.Surface
import kotlinx.coroutines.flow.Flow
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Manages the screen capture pipeline for streaming Android screen via WebRTC.
 *
 * Coordinates MediaProjection, VirtualDisplay, and H264Encoder to capture
 * the screen and produce encoded video frames suitable for WebRTC transmission.
 *
 * Usage:
 * 1. Obtain MediaProjection from Activity via MediaProjectionManager
 * 2. Call start() with the MediaProjection and encoding configuration
 * 3. Collect encoded frames from encodedFrames flow
 * 4. Call stop() when done to release resources
 *
 * Screen rotation changes are handled automatically by recreating the
 * VirtualDisplay with updated dimensions.
 */
class ScreenCaptureManager(private val context: Context) {

    private val encoder = H264Encoder()
    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var callbackThread: HandlerThread? = null
    private var callbackHandler: Handler? = null

    private val isCapturing = AtomicBoolean(false)
    private val currentConfig = AtomicReference<EncoderConfig?>(null)

    /**
     * Flow of encoded frames from the screen capture.
     *
     * Frames are emitted as they are produced by the encoder.
     * This flow is only active while capture is running.
     */
    val encodedFrames: Flow<EncodedFrame>
        get() = encoder.encodedFrames

    /**
     * Callback for MediaProjection events.
     */
    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() {
            Log.d(TAG, "MediaProjection stopped externally")
            stopInternal(releaseProjection = false)
        }

        override fun onCapturedContentResize(width: Int, height: Int) {
            Log.d(TAG, "Captured content resized: ${width}x$height")
            handleResolutionChange(width, height)
        }

        override fun onCapturedContentVisibilityChanged(isVisible: Boolean) {
            Log.d(TAG, "Captured content visibility changed: $isVisible")
        }
    }

    /**
     * Starts screen capture with the given MediaProjection.
     *
     * @param mediaProjection MediaProjection obtained from MediaProjectionManager
     * @param config Encoder configuration (resolution, bitrate, etc.)
     * @throws IllegalStateException if capture is already running
     * @throws IllegalArgumentException if config dimensions don't match screen
     */
    fun start(mediaProjection: MediaProjection, config: EncoderConfig) {
        check(!isCapturing.get()) { "Screen capture is already running" }

        Log.d(TAG, "Starting screen capture: ${config.width}x${config.height}")

        this.mediaProjection = mediaProjection
        currentConfig.set(config)

        // Create callback handler thread
        callbackThread = HandlerThread("ScreenCaptureCallbackThread").apply {
            start()
            callbackHandler = Handler(looper)
        }

        // Register projection callback
        mediaProjection.registerCallback(projectionCallback, callbackHandler)

        // Configure and start encoder
        encoder.configure(config)
        val inputSurface = encoder.getInputSurface()

        // Create VirtualDisplay to render screen to encoder's input surface
        virtualDisplay = createVirtualDisplay(config, inputSurface)

        // Start encoding
        encoder.start()
        isCapturing.set(true)

        Log.d(TAG, "Screen capture started")
    }

    /**
     * Creates a VirtualDisplay rendering to the given surface.
     */
    private fun createVirtualDisplay(config: EncoderConfig, surface: Surface): VirtualDisplay {
        val projection = mediaProjection
            ?: throw IllegalStateException("MediaProjection not available")

        val displayMetrics = context.resources.displayMetrics

        return projection.createVirtualDisplay(
            VIRTUAL_DISPLAY_NAME,
            config.width,
            config.height,
            displayMetrics.densityDpi,
            VIRTUAL_DISPLAY_FLAGS,
            surface,
            null, // VirtualDisplay.Callback
            callbackHandler
        )
    }

    /**
     * Handles resolution changes (e.g., screen rotation).
     *
     * Recreates the VirtualDisplay with the new dimensions while
     * maintaining the encoder session.
     */
    private fun handleResolutionChange(newWidth: Int, newHeight: Int) {
        if (!isCapturing.get()) return

        val config = currentConfig.get() ?: return

        // Check if dimensions actually changed (accounting for rotation)
        if ((config.width == newWidth && config.height == newHeight) ||
            (config.width == newHeight && config.height == newWidth)
        ) {
            // Dimensions match (possibly rotated), recreate virtual display
            Log.d(TAG, "Recreating VirtualDisplay for rotation")

            // Release old virtual display
            virtualDisplay?.release()

            // Create new config with swapped dimensions if needed
            val newConfig = if (config.width != newWidth) {
                EncoderConfig(
                    width = newWidth,
                    height = newHeight,
                    bitrate = config.bitrate,
                    frameRate = config.frameRate,
                    mimeType = config.mimeType,
                    iFrameIntervalSeconds = config.iFrameIntervalSeconds,
                    colorFormat = config.colorFormat
                )
            } else {
                config
            }

            currentConfig.set(newConfig)

            // Create new virtual display
            // Note: The encoder surface can handle the dimension change
            // as long as the new dimensions fit within the original allocation
            val inputSurface = encoder.getInputSurface()
            virtualDisplay = createVirtualDisplay(newConfig, inputSurface)
        }
    }

    /**
     * Requests a key frame from the encoder.
     *
     * Useful when a new WebRTC client connects and needs a key frame
     * to start decoding the video stream.
     */
    fun requestKeyFrame() {
        if (!isCapturing.get()) return
        encoder.requestKeyFrame()
    }

    /**
     * Stops screen capture and releases all resources.
     */
    fun stop() {
        stopInternal(releaseProjection = true)
    }

    /**
     * Internal stop implementation.
     *
     * @param releaseProjection Whether to stop the MediaProjection
     */
    private fun stopInternal(releaseProjection: Boolean) {
        if (!isCapturing.getAndSet(false)) return

        Log.d(TAG, "Stopping screen capture")

        // Release VirtualDisplay
        virtualDisplay?.release()
        virtualDisplay = null

        // Stop and release encoder
        encoder.release()

        // Unregister and optionally stop projection
        mediaProjection?.let { projection ->
            projection.unregisterCallback(projectionCallback)
            if (releaseProjection) {
                projection.stop()
            }
        }
        mediaProjection = null

        // Stop callback thread
        callbackThread?.quitSafely()
        callbackThread = null
        callbackHandler = null

        currentConfig.set(null)

        Log.d(TAG, "Screen capture stopped")
    }

    /**
     * Returns true if screen capture is currently active.
     */
    fun isCapturing(): Boolean = isCapturing.get()

    /**
     * Returns the current encoder configuration, or null if not capturing.
     */
    fun getCurrentConfig(): EncoderConfig? = currentConfig.get()

    /**
     * Returns capture statistics for monitoring.
     */
    fun getStatistics(): CaptureStatistics {
        return CaptureStatistics(
            isCapturing = isCapturing.get(),
            config = currentConfig.get(),
            encoderRunning = encoder.isRunning()
        )
    }

    companion object {
        private const val TAG = "ScreenCaptureManager"
        private const val VIRTUAL_DISPLAY_NAME = "AndroidRemoteScreenCapture"

        /**
         * VirtualDisplay flags for screen capture.
         * AUTO_MIRROR ensures the display mirrors the device screen.
         */
        private const val VIRTUAL_DISPLAY_FLAGS = DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR
    }
}

/**
 * Statistics about the current screen capture session.
 *
 * @property isCapturing Whether capture is currently active
 * @property config Current encoder configuration
 * @property encoderRunning Whether the encoder is actively producing frames
 */
data class CaptureStatistics(
    val isCapturing: Boolean,
    val config: EncoderConfig?,
    val encoderRunning: Boolean
)
