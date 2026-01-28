package com.androidremote.feature.input

import com.google.common.truth.Truth.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.CsvSource

/**
 * Tests for coordinate mapping from normalized (0-1) to screen pixels.
 *
 * The web UI sends normalized coordinates relative to the video element.
 * These must be mapped to actual screen pixels on the device.
 *
 * These tests are written FIRST (TDD) - implementation follows.
 */
class CoordinateMappingTest {

    @Test
    fun `maps center coordinates correctly`() {
        val mapper = CoordinateMapper(
            screenWidth = 1080,
            screenHeight = 2340,
            rotation = 0
        )

        val result = mapper.map(normalizedX = 0.5f, normalizedY = 0.5f)

        assertThat(result.x).isEqualTo(540)
        assertThat(result.y).isEqualTo(1170)
    }

    @Test
    fun `maps top-left corner`() {
        val mapper = CoordinateMapper(
            screenWidth = 1080,
            screenHeight = 2340,
            rotation = 0
        )

        val result = mapper.map(normalizedX = 0.0f, normalizedY = 0.0f)

        assertThat(result.x).isEqualTo(0)
        assertThat(result.y).isEqualTo(0)
    }

    @Test
    fun `maps bottom-right corner`() {
        val mapper = CoordinateMapper(
            screenWidth = 1080,
            screenHeight = 2340,
            rotation = 0
        )

        val result = mapper.map(normalizedX = 1.0f, normalizedY = 1.0f)

        assertThat(result.x).isEqualTo(1079) // 0-indexed, so max is width-1
        assertThat(result.y).isEqualTo(2339)
    }

    @Test
    fun `handles 90 degree rotation`() {
        // In landscape, width and height are swapped
        val mapper = CoordinateMapper(
            screenWidth = 2340,
            screenHeight = 1080,
            rotation = 90
        )

        // Top-left in the video should map correctly
        val result = mapper.map(normalizedX = 0.0f, normalizedY = 0.0f)

        assertThat(result.x).isEqualTo(0)
        assertThat(result.y).isEqualTo(0)
    }

    @Test
    fun `handles 180 degree rotation`() {
        val mapper = CoordinateMapper(
            screenWidth = 1080,
            screenHeight = 2340,
            rotation = 180
        )

        // In 180 rotation, coordinates are inverted
        val result = mapper.map(normalizedX = 0.0f, normalizedY = 0.0f)

        // Top-left in video becomes bottom-right on device
        assertThat(result.x).isEqualTo(1079)
        assertThat(result.y).isEqualTo(2339)
    }

    @Test
    fun `handles 270 degree rotation`() {
        val mapper = CoordinateMapper(
            screenWidth = 2340,
            screenHeight = 1080,
            rotation = 270
        )

        val result = mapper.map(normalizedX = 0.5f, normalizedY = 0.5f)

        // Center should still be center
        assertThat(result.x).isEqualTo(1170)
        assertThat(result.y).isEqualTo(540)
    }

    @Test
    fun `accounts for top notch inset`() {
        val mapper = CoordinateMapper(
            screenWidth = 1080,
            screenHeight = 2340,
            rotation = 0,
            topInset = 100
        )

        val result = mapper.map(normalizedX = 0.0f, normalizedY = 0.0f)

        // Top-left in video should account for notch
        assertThat(result.y).isEqualTo(100)
    }

    @Test
    fun `accounts for all insets`() {
        val mapper = CoordinateMapper(
            screenWidth = 1080,
            screenHeight = 2340,
            rotation = 0,
            topInset = 100,
            bottomInset = 50,
            leftInset = 0,
            rightInset = 0
        )

        // The capture area is reduced by insets
        // So normalized 0,0 maps to (0, topInset)
        // And normalized 1,1 maps to (width-1, height-bottomInset-1)

        val topLeft = mapper.map(0.0f, 0.0f)
        assertThat(topLeft.y).isEqualTo(100)

        val bottomRight = mapper.map(1.0f, 1.0f)
        assertThat(bottomRight.y).isEqualTo(2340 - 50 - 1)
    }

    @Test
    fun `clamps out-of-bounds coordinates`() {
        val mapper = CoordinateMapper(
            screenWidth = 1080,
            screenHeight = 2340,
            rotation = 0
        )

        val tooLarge = mapper.map(normalizedX = 1.5f, normalizedY = 1.5f)
        assertThat(tooLarge.x).isAtMost(1079)
        assertThat(tooLarge.y).isAtMost(2339)

        val tooSmall = mapper.map(normalizedX = -0.5f, normalizedY = -0.5f)
        assertThat(tooSmall.x).isAtLeast(0)
        assertThat(tooSmall.y).isAtLeast(0)
    }

    @ParameterizedTest
    @CsvSource(
        "0.0, 0.0, 0, 0",
        "0.5, 0.5, 540, 1170",
        "1.0, 1.0, 1079, 2339",
        "0.25, 0.75, 270, 1754"
    )
    fun `maps various coordinates correctly`(
        normalizedX: Float,
        normalizedY: Float,
        expectedX: Int,
        expectedY: Int
    ) {
        val mapper = CoordinateMapper(
            screenWidth = 1080,
            screenHeight = 2340,
            rotation = 0
        )

        val result = mapper.map(normalizedX, normalizedY)

        assertThat(result.x).isEqualTo(expectedX)
        assertThat(result.y).isEqualTo(expectedY)
    }
}
