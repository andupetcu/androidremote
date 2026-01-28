package com.androidremote.feature.input

/**
 * Interface for input injection implementations.
 *
 * Different implementations provide different trade-offs:
 * - [AdbShellInjector]: Uses shell commands, ~100-200ms per action, no daemon needed
 * - RootDaemonInjector: Uses Unix socket to daemon, <10ms per action, requires daemon
 * - AccessibilityInjector: Uses AccessibilityService, user must enable, limited gestures
 *
 * ## Usage
 *
 * ```kotlin
 * val injector = InputInjectorFactory.create(context)
 * if (injector.isAvailable()) {
 *     injector.tap(500, 800)
 *     injector.swipe(100, 500, 900, 500, 300)
 * }
 * ```
 */
interface InputInjector {

    /**
     * Perform a tap at the given screen coordinates.
     *
     * @param x X coordinate in screen pixels
     * @param y Y coordinate in screen pixels
     * @return Result indicating success or failure
     */
    suspend fun tap(x: Int, y: Int): Result<Unit>

    /**
     * Perform a swipe gesture from start to end coordinates.
     *
     * @param startX Starting X coordinate
     * @param startY Starting Y coordinate
     * @param endX Ending X coordinate
     * @param endY Ending Y coordinate
     * @param durationMs Duration of the swipe in milliseconds
     * @return Result indicating success or failure
     */
    suspend fun swipe(
        startX: Int,
        startY: Int,
        endX: Int,
        endY: Int,
        durationMs: Long = 300
    ): Result<Unit>

    /**
     * Perform a long press at the given coordinates.
     *
     * @param x X coordinate in screen pixels
     * @param y Y coordinate in screen pixels
     * @param durationMs Duration to hold the press in milliseconds
     * @return Result indicating success or failure
     */
    suspend fun longPress(x: Int, y: Int, durationMs: Long = 500): Result<Unit>

    /**
     * Send a key event.
     *
     * @param keyCode Android KeyEvent code (e.g., KeyEvent.KEYCODE_BACK)
     * @return Result indicating success or failure
     */
    suspend fun keyEvent(keyCode: Int): Result<Unit>

    /**
     * Input text as if typing on a keyboard.
     *
     * Note: Special characters may not work on all implementations.
     * Prefer ASCII characters for maximum compatibility.
     *
     * @param text Text to input
     * @return Result indicating success or failure
     */
    suspend fun text(text: String): Result<Unit>

    /**
     * Check if this injector is available and functional.
     *
     * @return true if the injector can perform input operations
     */
    fun isAvailable(): Boolean

    /**
     * Get a human-readable name for this injector type.
     */
    fun getName(): String
}

/**
 * Exception thrown when input injection fails.
 */
class InputInjectionException(
    message: String,
    cause: Throwable? = null
) : Exception(message, cause)
