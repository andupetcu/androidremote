package com.androidremote.feature.screen

import android.content.Context
import android.util.Log

/**
 * Factory for creating [ScreenCapturer] implementations.
 *
 * Selection priority for shell-based capture (no user consent):
 * 1. ADB Screen Capture (if shell access available)
 *
 * Note: For real-time streaming with MediaProjection (requires user consent),
 * use [ScreenCaptureManager] directly.
 *
 * ## Usage
 *
 * ```kotlin
 * // For shell-based capture (no user consent, lower fps)
 * val capturer = ScreenCapturerFactory.createShellCapturer()
 * if (capturer != null && capturer.isAvailable()) {
 *     val bitmap = capturer.captureFrame().getOrNull()
 * }
 *
 * // For real-time capture (requires user consent)
 * val manager = ScreenCaptureManager(context)
 * manager.start(mediaProjection, config)
 * manager.encodedFrames.collect { frame -> ... }
 * ```
 */
object ScreenCapturerFactory {

    private const val TAG = "ScreenCapturerFactory"

    /**
     * Create the best available shell-based screen capturer.
     *
     * Shell-based capturers don't require user consent but are slower
     * and require shell/root access.
     *
     * @return ScreenCapturer if available, null otherwise
     */
    fun createShellCapturer(): ScreenCapturer? {
        val capturer = AdbScreenCapturer()

        return if (capturer.isAvailable()) {
            Log.i(TAG, "Created shell screen capturer: ${capturer.getName()}")
            capturer
        } else {
            Log.w(TAG, "No shell screen capturer available")
            null
        }
    }

    /**
     * Create the real-time screen capture manager.
     *
     * This requires MediaProjection which needs user consent via
     * MediaProjectionManager.createScreenCaptureIntent().
     *
     * @param context Android context
     * @return ScreenCaptureManager for real-time capture
     */
    fun createRealTimeManager(context: Context): ScreenCaptureManager {
        Log.d(TAG, "Created real-time screen capture manager")
        return ScreenCaptureManager(context)
    }

    /**
     * Check if any shell-based screen capturer is available.
     *
     * @return true if shell capture is available
     */
    fun isShellCaptureAvailable(): Boolean {
        return AdbScreenCapturer().isAvailable()
    }
}

/**
 * Types of screen capturer implementations.
 */
enum class CapturerType {
    /** ADB shell screencap command */
    ADB_SHELL,

    /** MediaProjection-based (requires user consent) */
    MEDIA_PROJECTION
}
