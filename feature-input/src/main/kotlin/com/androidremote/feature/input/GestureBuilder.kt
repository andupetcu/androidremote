package com.androidremote.feature.input

/**
 * A stroke in a gesture (one finger's movement).
 *
 * For simple gestures like tap, start and end are the same.
 * For swipes, they differ.
 * For complex drags, use the path list.
 */
data class GestureStroke(
    val startX: Int,
    val startY: Int,
    val endX: Int,
    val endY: Int,
    val path: List<ScreenPoint> = listOf(ScreenPoint(startX, startY), ScreenPoint(endX, endY))
)

/**
 * A complete gesture specification.
 *
 * This is an abstraction over Android's GestureDescription that can be
 * tested without Android dependencies.
 *
 * @property strokeCount Number of simultaneous touches (1 for tap/swipe, 2 for pinch)
 * @property duration Total duration of the gesture in milliseconds
 * @property strokes The individual strokes (finger movements)
 */
data class GestureSpec(
    val strokeCount: Int,
    val duration: Long,
    val strokes: List<GestureStroke>
) {
    init {
        require(strokeCount > 0) { "Stroke count must be positive" }
        require(duration > 0) { "Duration must be positive" }
        require(strokes.size == strokeCount) { "Strokes list size must match strokeCount" }
    }
}

/**
 * Builds gesture specifications from input commands.
 *
 * These specifications can then be converted to Android's GestureDescription
 * for injection via AccessibilityService.
 *
 * Minimum durations are enforced for reliability across different devices.
 */
object GestureBuilder {

    /** Minimum tap duration for reliable detection */
    const val MIN_TAP_DURATION_MS = 100L

    /** Default long press duration */
    const val LONG_PRESS_DURATION_MS = 600L

    /** Minimum gesture duration for reliability */
    const val MIN_GESTURE_DURATION_MS = 50L

    /**
     * Builds a tap gesture at the specified coordinates.
     *
     * @param x X coordinate in screen pixels
     * @param y Y coordinate in screen pixels
     * @return A gesture specification for a tap
     */
    fun tap(x: Int, y: Int): GestureSpec {
        val stroke = GestureStroke(
            startX = x,
            startY = y,
            endX = x,
            endY = y
        )
        return GestureSpec(
            strokeCount = 1,
            duration = MIN_TAP_DURATION_MS,
            strokes = listOf(stroke)
        )
    }

    /**
     * Builds a long press gesture at the specified coordinates.
     *
     * @param x X coordinate in screen pixels
     * @param y Y coordinate in screen pixels
     * @param durationMs How long to hold (default: 600ms)
     * @return A gesture specification for a long press
     */
    fun longPress(x: Int, y: Int, durationMs: Long = LONG_PRESS_DURATION_MS): GestureSpec {
        val stroke = GestureStroke(
            startX = x,
            startY = y,
            endX = x,
            endY = y
        )
        return GestureSpec(
            strokeCount = 1,
            duration = maxOf(durationMs, MIN_GESTURE_DURATION_MS),
            strokes = listOf(stroke)
        )
    }

    /**
     * Builds a swipe gesture from start to end coordinates.
     *
     * @param startX Starting X coordinate
     * @param startY Starting Y coordinate
     * @param endX Ending X coordinate
     * @param endY Ending Y coordinate
     * @param durationMs Duration of the swipe
     * @return A gesture specification for a swipe
     */
    fun swipe(startX: Int, startY: Int, endX: Int, endY: Int, durationMs: Long): GestureSpec {
        val stroke = GestureStroke(
            startX = startX,
            startY = startY,
            endX = endX,
            endY = endY
        )
        return GestureSpec(
            strokeCount = 1,
            duration = maxOf(durationMs, MIN_GESTURE_DURATION_MS),
            strokes = listOf(stroke)
        )
    }

    /**
     * Builds a pinch gesture for zooming.
     *
     * @param centerX Center X of the pinch
     * @param centerY Center Y of the pinch
     * @param startDistance Initial distance between fingers
     * @param endDistance Final distance between fingers
     * @param durationMs Duration of the pinch
     * @return A gesture specification for a pinch (2 strokes)
     */
    fun pinch(
        centerX: Int,
        centerY: Int,
        startDistance: Int,
        endDistance: Int,
        durationMs: Long
    ): GestureSpec {
        // Calculate finger positions (horizontal pinch, fingers on either side of center)
        val startHalf = startDistance / 2
        val endHalf = endDistance / 2

        // First finger: starts left of center, moves based on zoom direction
        val stroke1 = GestureStroke(
            startX = centerX - startHalf,
            startY = centerY,
            endX = centerX - endHalf,
            endY = centerY
        )

        // Second finger: starts right of center, mirrors first finger
        val stroke2 = GestureStroke(
            startX = centerX + startHalf,
            startY = centerY,
            endX = centerX + endHalf,
            endY = centerY
        )

        return GestureSpec(
            strokeCount = 2,
            duration = maxOf(durationMs, MIN_GESTURE_DURATION_MS),
            strokes = listOf(stroke1, stroke2)
        )
    }

    /**
     * Builds a drag gesture following a path.
     *
     * @param path List of points to follow
     * @param durationMs Total duration of the drag
     * @return A gesture specification for a drag
     */
    fun drag(path: List<ScreenPoint>, durationMs: Long): GestureSpec {
        require(path.isNotEmpty()) { "Path must not be empty" }

        val firstPoint = path.first()
        val lastPoint = path.last()

        val stroke = GestureStroke(
            startX = firstPoint.x,
            startY = firstPoint.y,
            endX = lastPoint.x,
            endY = lastPoint.y,
            path = path
        )

        return GestureSpec(
            strokeCount = 1,
            duration = maxOf(durationMs, MIN_GESTURE_DURATION_MS),
            strokes = listOf(stroke)
        )
    }
}
