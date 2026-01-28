package com.androidremote.feature.screen

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Screen capturer that uses ADB shell commands.
 *
 * This implementation runs `screencap -p` via Runtime.exec() to capture
 * the screen as a PNG image.
 *
 * ## Requirements
 *
 * This capturer works when:
 * - The app runs with shell UID (via `adb shell am start`)
 * - The device is rooted and the app has root access
 * - The app is a system app with appropriate permissions
 *
 * ## Performance
 *
 * Each capture takes ~300-500ms due to:
 * - Process spawn overhead
 * - PNG encoding on device
 * - Data transfer through pipe
 *
 * For real-time streaming, use [ScreenCaptureManager] with MediaProjection instead.
 *
 * ## Usage
 *
 * ```kotlin
 * val capturer = AdbScreenCapturer()
 * if (capturer.isAvailable()) {
 *     // Single frame
 *     val bitmap = capturer.captureFrame().getOrNull()
 *
 *     // Low-fps stream (good for monitoring, not real-time control)
 *     capturer.startStream(fps = 2).collect { bitmap ->
 *         // Update preview
 *     }
 * }
 * ```
 */
class AdbScreenCapturer : ScreenCapturer {

    companion object {
        private const val TAG = "AdbScreenCapturer"
        private const val SCREENCAP_COMMAND = "screencap -p"
        private const val CAPTURE_TIMEOUT_MS = 5000L
    }

    // Cache availability check
    private var availabilityChecked = false
    private var available = false

    // Streaming state
    private val isStreaming = AtomicBoolean(false)

    override suspend fun captureFrame(): Result<Bitmap> = withContext(Dispatchers.IO) {
        try {
            Log.d(TAG, "Capturing screen frame")
            val startTime = System.currentTimeMillis()

            val process = Runtime.getRuntime().exec(arrayOf("sh", "-c", SCREENCAP_COMMAND))

            // Read PNG data from stdout
            val inputStream = process.inputStream
            val bitmap = BitmapFactory.decodeStream(inputStream)

            val exitCode = process.waitFor()
            val elapsed = System.currentTimeMillis() - startTime

            Log.d(TAG, "Screen capture completed in ${elapsed}ms, exit code: $exitCode")

            if (bitmap != null) {
                Log.d(TAG, "Captured bitmap: ${bitmap.width}x${bitmap.height}")
                Result.success(bitmap)
            } else {
                val errorMessage = if (exitCode != 0) {
                    // Read stderr for error message
                    val stderr = process.errorStream.bufferedReader().readText().trim()
                    "screencap failed (exit $exitCode): $stderr"
                } else {
                    "Failed to decode screenshot bitmap"
                }
                Log.w(TAG, errorMessage)
                Result.failure(ScreenCaptureException(errorMessage))
            }
        } catch (e: Exception) {
            Log.e(TAG, "Screen capture failed", e)
            Result.failure(ScreenCaptureException("Screen capture failed: ${e.message}", e))
        }
    }

    override fun startStream(fps: Int): Flow<Bitmap> = flow {
        val frameInterval = 1000L / fps.coerceIn(1, 30)

        isStreaming.set(true)
        Log.d(TAG, "Starting screen capture stream at $fps fps (interval: ${frameInterval}ms)")

        try {
            while (isStreaming.get() && currentCoroutineContext().isActive) {
                val startTime = System.currentTimeMillis()

                val result = captureFrame()
                if (result.isSuccess) {
                    emit(result.getOrThrow())
                } else {
                    Log.w(TAG, "Frame capture failed, continuing stream")
                }

                // Calculate delay to maintain target fps
                val elapsed = System.currentTimeMillis() - startTime
                val delayTime = (frameInterval - elapsed).coerceAtLeast(0)
                if (delayTime > 0) {
                    delay(delayTime)
                }
            }
        } finally {
            isStreaming.set(false)
            Log.d(TAG, "Screen capture stream stopped")
        }
    }.flowOn(Dispatchers.IO)

    override fun stopStream() {
        if (isStreaming.getAndSet(false)) {
            Log.d(TAG, "Stopping screen capture stream")
        }
    }

    override fun isAvailable(): Boolean {
        if (availabilityChecked) {
            return available
        }

        // Try to run screencap with no args to check if we have access
        available = try {
            val process = Runtime.getRuntime().exec(arrayOf("sh", "-c", "screencap -h"))
            val exitCode = process.waitFor()
            // screencap -h returns 1 with usage info if available
            exitCode == 0 || exitCode == 1
        } catch (e: Exception) {
            Log.w(TAG, "screencap not available", e)
            false
        }

        availabilityChecked = true
        Log.d(TAG, "screencap available: $available")
        return available
    }

    override fun getName(): String = "ADB Screen Capture"

    override fun release() {
        stopStream()
    }

    /**
     * Capture to a file instead of returning a Bitmap.
     *
     * More efficient for large screens as it avoids memory allocation.
     *
     * @param outputPath Path to save the PNG file
     * @return Result indicating success or failure
     */
    suspend fun captureToFile(outputPath: String): Result<Unit> = withContext(Dispatchers.IO) {
        try {
            Log.d(TAG, "Capturing screen to file: $outputPath")
            val startTime = System.currentTimeMillis()

            val process = Runtime.getRuntime()
                .exec(arrayOf("sh", "-c", "screencap -p $outputPath"))
            val exitCode = process.waitFor()

            val elapsed = System.currentTimeMillis() - startTime
            Log.d(TAG, "Screen capture to file completed in ${elapsed}ms")

            if (exitCode == 0) {
                Result.success(Unit)
            } else {
                val stderr = process.errorStream.bufferedReader().readText().trim()
                val errorMessage = "screencap failed (exit $exitCode): $stderr"
                Log.w(TAG, errorMessage)
                Result.failure(ScreenCaptureException(errorMessage))
            }
        } catch (e: Exception) {
            Log.e(TAG, "Screen capture to file failed", e)
            Result.failure(ScreenCaptureException("Screen capture failed: ${e.message}", e))
        }
    }
}

/**
 * Helper to get current coroutine context for checking isActive.
 */
private suspend fun currentCoroutineContext() = kotlin.coroutines.coroutineContext
