package com.androidremote.feature.screen

import android.graphics.Bitmap
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow

/**
 * Interface for screen capture implementations.
 *
 * Different implementations provide different trade-offs:
 * - [ScreenCaptureManager]: MediaProjection-based, requires user consent, real-time streaming
 * - [AdbScreenCapturer]: Shell-based, no user consent needed, ~300-500ms per frame
 *
 * ## Usage
 *
 * ```kotlin
 * val capturer = ScreenCapturerFactory.create()
 * if (capturer.isAvailable()) {
 *     // Single frame capture
 *     val bitmap = capturer.captureFrame().getOrNull()
 *
 *     // Or stream frames
 *     capturer.startStream(fps = 5).collect { bitmap ->
 *         // Process frame
 *     }
 * }
 * ```
 */
interface ScreenCapturer {

    /**
     * Capture a single frame of the screen.
     *
     * @return Result containing the captured Bitmap, or failure
     */
    suspend fun captureFrame(): Result<Bitmap>

    /**
     * Start a continuous stream of screen captures.
     *
     * @param fps Target frames per second (actual rate may be lower)
     * @return Flow of captured Bitmaps
     */
    fun startStream(fps: Int = 1): Flow<Bitmap>

    /**
     * Stop any active streaming.
     */
    fun stopStream()

    /**
     * Check if this capturer is available and functional.
     *
     * @return true if the capturer can capture the screen
     */
    fun isAvailable(): Boolean

    /**
     * Get a human-readable name for this capturer type.
     */
    fun getName(): String

    /**
     * Release any resources held by this capturer.
     */
    fun release()
}

/**
 * Exception thrown when screen capture fails.
 */
class ScreenCaptureException(
    message: String,
    cause: Throwable? = null
) : Exception(message, cause)
