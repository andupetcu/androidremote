package com.androidremote.feature.input

import com.google.common.truth.Truth.assertThat
import org.junit.jupiter.api.Test

/**
 * Tests for building gesture descriptions from input commands.
 *
 * These tests verify the gesture building logic without Android dependencies.
 * The GestureDescription itself is an Android class, but we can test the
 * parameters and paths that go into building it.
 *
 * These tests are written FIRST (TDD) - implementation follows.
 */
class GestureBuilderTest {

    @Test
    fun `builds tap gesture`() {
        val gesture = GestureBuilder.tap(x = 540, y = 1170)

        assertThat(gesture.strokeCount).isEqualTo(1)
        assertThat(gesture.duration).isEqualTo(100L) // Quick tap
        assertThat(gesture.strokes[0].startX).isEqualTo(540)
        assertThat(gesture.strokes[0].startY).isEqualTo(1170)
        assertThat(gesture.strokes[0].endX).isEqualTo(540)
        assertThat(gesture.strokes[0].endY).isEqualTo(1170)
    }

    @Test
    fun `builds long press gesture`() {
        val gesture = GestureBuilder.longPress(x = 540, y = 1170)

        assertThat(gesture.strokeCount).isEqualTo(1)
        assertThat(gesture.duration).isGreaterThan(500L)
        assertThat(gesture.strokes[0].startX).isEqualTo(540)
        assertThat(gesture.strokes[0].startY).isEqualTo(1170)
    }

    @Test
    fun `builds swipe gesture`() {
        val gesture = GestureBuilder.swipe(
            startX = 540, startY = 1500,
            endX = 540, endY = 500,
            durationMs = 300
        )

        assertThat(gesture.strokeCount).isEqualTo(1)
        assertThat(gesture.duration).isEqualTo(300L)
        assertThat(gesture.strokes[0].startX).isEqualTo(540)
        assertThat(gesture.strokes[0].startY).isEqualTo(1500)
        assertThat(gesture.strokes[0].endX).isEqualTo(540)
        assertThat(gesture.strokes[0].endY).isEqualTo(500)
    }

    @Test
    fun `builds horizontal swipe`() {
        val gesture = GestureBuilder.swipe(
            startX = 100, startY = 1000,
            endX = 900, endY = 1000,
            durationMs = 250
        )

        assertThat(gesture.strokes[0].startX).isEqualTo(100)
        assertThat(gesture.strokes[0].endX).isEqualTo(900)
        assertThat(gesture.strokes[0].startY).isEqualTo(gesture.strokes[0].endY)
    }

    @Test
    fun `builds pinch gesture for zoom in`() {
        val gesture = GestureBuilder.pinch(
            centerX = 540, centerY = 1170,
            startDistance = 100, endDistance = 300, // Zoom in
            durationMs = 400
        )

        assertThat(gesture.strokeCount).isEqualTo(2) // Two fingers
        assertThat(gesture.duration).isEqualTo(400L)

        // Fingers should start close and move apart
        val stroke1 = gesture.strokes[0]
        val stroke2 = gesture.strokes[1]

        // Start distance between fingers
        val startDist = distance(stroke1.startX, stroke1.startY, stroke2.startX, stroke2.startY)
        // End distance between fingers
        val endDist = distance(stroke1.endX, stroke1.endY, stroke2.endX, stroke2.endY)

        assertThat(endDist).isGreaterThan(startDist)
    }

    @Test
    fun `builds pinch gesture for zoom out`() {
        val gesture = GestureBuilder.pinch(
            centerX = 540, centerY = 1170,
            startDistance = 300, endDistance = 100, // Zoom out
            durationMs = 400
        )

        assertThat(gesture.strokeCount).isEqualTo(2)

        val stroke1 = gesture.strokes[0]
        val stroke2 = gesture.strokes[1]

        val startDist = distance(stroke1.startX, stroke1.startY, stroke2.startX, stroke2.startY)
        val endDist = distance(stroke1.endX, stroke1.endY, stroke2.endX, stroke2.endY)

        assertThat(endDist).isLessThan(startDist)
    }

    @Test
    fun `builds drag gesture with path`() {
        val path = listOf(
            ScreenPoint(100, 100),
            ScreenPoint(200, 150),
            ScreenPoint(300, 200),
            ScreenPoint(400, 250)
        )

        val gesture = GestureBuilder.drag(path, durationMs = 500)

        assertThat(gesture.strokeCount).isEqualTo(1)
        assertThat(gesture.duration).isEqualTo(500L)
        assertThat(gesture.strokes[0].path).hasSize(4)
    }

    @Test
    fun `tap gesture has minimum duration for reliability`() {
        val gesture = GestureBuilder.tap(x = 0, y = 0)

        // Too short a tap might not be recognized by all apps
        assertThat(gesture.duration).isAtLeast(50L)
    }

    @Test
    fun `swipe gesture validates minimum duration`() {
        val gesture = GestureBuilder.swipe(
            startX = 0, startY = 0,
            endX = 1000, endY = 0,
            durationMs = 10 // Very fast
        )

        // Should be clamped to a minimum for reliability
        assertThat(gesture.duration).isAtLeast(50L)
    }

    private fun distance(x1: Int, y1: Int, x2: Int, y2: Int): Double {
        val dx = (x2 - x1).toDouble()
        val dy = (y2 - y1).toDouble()
        return kotlin.math.sqrt(dx * dx + dy * dy)
    }
}
