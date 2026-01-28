package com.androidremote.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Base interface for all remote control commands.
 *
 * Commands are sent from the web UI to the device and represent
 * user interactions like taps, swipes, and key presses.
 */
sealed interface RemoteCommand {
    val type: String
}

/**
 * Tap at normalized coordinates (0-1).
 *
 * @property x Horizontal position from 0 (left) to 1 (right)
 * @property y Vertical position from 0 (top) to 1 (bottom)
 */
@Serializable
@SerialName("TAP")
data class TapCommand(
    val x: Float,
    val y: Float
) : RemoteCommand {
    override val type: String = "TAP"

    init {
        require(x in 0f..1f) { "x must be between 0 and 1" }
        require(y in 0f..1f) { "y must be between 0 and 1" }
    }
}

/**
 * Long press at normalized coordinates.
 *
 * @property x Horizontal position from 0 (left) to 1 (right)
 * @property y Vertical position from 0 (top) to 1 (bottom)
 * @property durationMs How long to hold in milliseconds
 */
@Serializable
@SerialName("LONG_PRESS")
data class LongPressCommand(
    val x: Float,
    val y: Float,
    val durationMs: Long = 600
) : RemoteCommand {
    override val type: String = "LONG_PRESS"

    init {
        require(x in 0f..1f) { "x must be between 0 and 1" }
        require(y in 0f..1f) { "y must be between 0 and 1" }
        require(durationMs > 0) { "durationMs must be positive" }
    }
}

/**
 * Swipe gesture from start to end coordinates.
 *
 * @property startX Starting horizontal position (0-1)
 * @property startY Starting vertical position (0-1)
 * @property endX Ending horizontal position (0-1)
 * @property endY Ending vertical position (0-1)
 * @property durationMs Duration of the swipe in milliseconds
 */
@Serializable
@SerialName("SWIPE")
data class SwipeCommand(
    val startX: Float,
    val startY: Float,
    val endX: Float,
    val endY: Float,
    val durationMs: Long = 300
) : RemoteCommand {
    override val type: String = "SWIPE"

    init {
        require(startX in 0f..1f) { "startX must be between 0 and 1" }
        require(startY in 0f..1f) { "startY must be between 0 and 1" }
        require(endX in 0f..1f) { "endX must be between 0 and 1" }
        require(endY in 0f..1f) { "endY must be between 0 and 1" }
        require(durationMs > 0) { "durationMs must be positive" }
    }
}

/**
 * Pinch gesture for zoom in/out.
 *
 * @property centerX Center horizontal position (0-1)
 * @property centerY Center vertical position (0-1)
 * @property startDistance Initial distance between fingers (0-1, as fraction of screen)
 * @property endDistance Final distance between fingers (0-1)
 * @property durationMs Duration of the pinch in milliseconds
 */
@Serializable
@SerialName("PINCH")
data class PinchCommand(
    val centerX: Float,
    val centerY: Float,
    val startDistance: Float,
    val endDistance: Float,
    val durationMs: Long = 400
) : RemoteCommand {
    override val type: String = "PINCH"

    init {
        require(centerX in 0f..1f) { "centerX must be between 0 and 1" }
        require(centerY in 0f..1f) { "centerY must be between 0 and 1" }
        require(startDistance > 0f) { "startDistance must be positive" }
        require(endDistance > 0f) { "endDistance must be positive" }
        require(durationMs > 0) { "durationMs must be positive" }
    }
}

/**
 * Hardware/software key press.
 *
 * @property keyCode The key to press
 */
@Serializable
@SerialName("KEY_EVENT")
data class KeyEventCommand(
    val keyCode: KeyCode
) : RemoteCommand {
    override val type: String = "KEY_EVENT"
}

/**
 * Text input for typing into focused field.
 *
 * @property text The text to input
 */
@Serializable
@SerialName("TEXT_INPUT")
data class TextInputCommand(
    val text: String
) : RemoteCommand {
    override val type: String = "TEXT_INPUT"
}

/**
 * Supported key codes for key events.
 */
@Serializable
enum class KeyCode {
    BACK,
    HOME,
    RECENT_APPS,
    VOLUME_UP,
    VOLUME_DOWN,
    POWER,
    ENTER,
    TAB,
    DELETE,
    ESCAPE
}
