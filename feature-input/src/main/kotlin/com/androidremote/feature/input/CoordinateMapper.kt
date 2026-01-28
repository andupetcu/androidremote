package com.androidremote.feature.input

/**
 * A point in screen pixel coordinates.
 */
data class ScreenPoint(val x: Int, val y: Int)

/**
 * Maps normalized coordinates (0-1) from the web UI to screen pixels.
 *
 * The web UI sends touch coordinates relative to the video element.
 * This mapper transforms them to actual screen pixels, accounting for:
 * - Screen resolution
 * - Device rotation
 * - Notch and navigation bar insets
 *
 * @param screenWidth The screen width in pixels
 * @param screenHeight The screen height in pixels
 * @param rotation The current rotation in degrees (0, 90, 180, 270)
 * @param topInset Pixels occupied by the status bar/notch
 * @param bottomInset Pixels occupied by the navigation bar
 * @param leftInset Pixels occupied by left edge inset
 * @param rightInset Pixels occupied by right edge inset
 */
class CoordinateMapper(
    val screenWidth: Int,
    val screenHeight: Int,
    val rotation: Int = 0,
    val topInset: Int = 0,
    val bottomInset: Int = 0,
    val leftInset: Int = 0,
    val rightInset: Int = 0
) {
    init {
        require(screenWidth > 0) { "Screen width must be positive" }
        require(screenHeight > 0) { "Screen height must be positive" }
        require(rotation in listOf(0, 90, 180, 270)) { "Rotation must be 0, 90, 180, or 270" }
        require(topInset >= 0) { "Top inset must be non-negative" }
        require(bottomInset >= 0) { "Bottom inset must be non-negative" }
        require(leftInset >= 0) { "Left inset must be non-negative" }
        require(rightInset >= 0) { "Right inset must be non-negative" }
    }

    /**
     * Maps normalized coordinates to screen pixels.
     *
     * @param normalizedX X coordinate from 0 (left) to 1 (right)
     * @param normalizedY Y coordinate from 0 (top) to 1 (bottom)
     * @return Screen coordinates in pixels
     */
    fun map(normalizedX: Float, normalizedY: Float): ScreenPoint {
        // Clamp input to valid range
        val clampedX = normalizedX.coerceIn(0f, 1f)
        val clampedY = normalizedY.coerceIn(0f, 1f)

        // Calculate the usable area (excluding insets)
        val usableWidth = screenWidth - leftInset - rightInset
        val usableHeight = screenHeight - topInset - bottomInset

        val x: Int
        val y: Int

        when (rotation) {
            180 -> {
                // Inverted mapping for 180° rotation
                // Top-left in video becomes bottom-right on device
                x = rightInset + ((1 - clampedX) * (usableWidth - 1) + 0.5f).toInt()
                y = bottomInset + ((1 - clampedY) * (usableHeight - 1) + 0.5f).toInt()
            }
            else -> {
                // Direct mapping for 0°, 90°, 270°
                // The screen dimensions are already swapped by the caller for landscape
                x = leftInset + (clampedX * (usableWidth - 1) + 0.5f).toInt()
                y = topInset + (clampedY * (usableHeight - 1) + 0.5f).toInt()
            }
        }

        // Clamp to valid screen range
        return ScreenPoint(
            x.coerceIn(0, screenWidth - 1),
            y.coerceIn(0, screenHeight - 1)
        )
    }

    /**
     * Creates a new mapper with updated screen dimensions.
     *
     * Useful when the screen rotates or configuration changes.
     */
    fun withDimensions(width: Int, height: Int, rotation: Int): CoordinateMapper {
        return CoordinateMapper(
            screenWidth = width,
            screenHeight = height,
            rotation = rotation,
            topInset = topInset,
            bottomInset = bottomInset,
            leftInset = leftInset,
            rightInset = rightInset
        )
    }

    /**
     * Creates a new mapper with updated insets.
     */
    fun withInsets(top: Int, bottom: Int, left: Int, right: Int): CoordinateMapper {
        return CoordinateMapper(
            screenWidth = screenWidth,
            screenHeight = screenHeight,
            rotation = rotation,
            topInset = top,
            bottomInset = bottom,
            leftInset = left,
            rightInset = right
        )
    }
}
