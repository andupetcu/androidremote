package com.androidremote.feature.screen

import com.google.common.truth.Truth.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.CsvSource

/**
 * Tests for video encoder configuration.
 *
 * EncoderConfig determines the optimal encoding parameters for screen capture
 * based on resolution, bandwidth constraints, and device rotation.
 *
 * These tests are written FIRST (TDD) - implementation follows.
 */
class EncoderConfigTest {

    @Test
    fun `creates valid H264 encoder config for 1080p`() {
        val config = EncoderConfig.forResolution(1920, 1080)

        assertThat(config.width).isEqualTo(1920)
        assertThat(config.height).isEqualTo(1080)
        assertThat(config.bitrate).isEqualTo(4_000_000) // 4 Mbps
        assertThat(config.frameRate).isEqualTo(30)
        assertThat(config.mimeType).isEqualTo("video/avc")
    }

    @Test
    fun `creates valid H264 encoder config for 720p`() {
        val config = EncoderConfig.forResolution(1280, 720)

        assertThat(config.width).isEqualTo(1280)
        assertThat(config.height).isEqualTo(720)
        assertThat(config.bitrate).isEqualTo(2_500_000) // 2.5 Mbps
        assertThat(config.frameRate).isEqualTo(30)
    }

    @Test
    fun `creates valid H264 encoder config for 1440p`() {
        val config = EncoderConfig.forResolution(2560, 1440)

        assertThat(config.width).isEqualTo(2560)
        assertThat(config.height).isEqualTo(1440)
        assertThat(config.bitrate).isEqualTo(8_000_000) // 8 Mbps
        assertThat(config.frameRate).isEqualTo(30)
    }

    @Test
    fun `scales down for bandwidth constraints`() {
        val config = EncoderConfig.forResolution(1920, 1080)
            .withMaxBitrate(1_000_000) // 1 Mbps limit

        // Should scale down to fit bandwidth
        assertThat(config.width).isAtMost(1280)
        assertThat(config.height).isAtMost(720)
        assertThat(config.bitrate).isAtMost(1_000_000)
    }

    @Test
    fun `handles rotation correctly - landscape from portrait`() {
        // Device is in landscape (rotation 90), but native resolution is portrait
        val config = EncoderConfig.forResolution(1080, 1920, rotation = 90)

        // Width and height should be swapped for landscape
        assertThat(config.width).isEqualTo(1920)
        assertThat(config.height).isEqualTo(1080)
    }

    @Test
    fun `handles rotation correctly - 180 degrees`() {
        val config = EncoderConfig.forResolution(1920, 1080, rotation = 180)

        // Dimensions unchanged for 180 rotation (just upside down)
        assertThat(config.width).isEqualTo(1920)
        assertThat(config.height).isEqualTo(1080)
    }

    @Test
    fun `handles rotation correctly - 270 degrees`() {
        val config = EncoderConfig.forResolution(1080, 1920, rotation = 270)

        // Width and height should be swapped
        assertThat(config.width).isEqualTo(1920)
        assertThat(config.height).isEqualTo(1080)
    }

    @Test
    fun `allows custom frame rate`() {
        val config = EncoderConfig.forResolution(1920, 1080)
            .withFrameRate(60)

        assertThat(config.frameRate).isEqualTo(60)
    }

    @Test
    fun `clamps frame rate to valid range`() {
        val configLow = EncoderConfig.forResolution(1920, 1080)
            .withFrameRate(5) // Too low

        val configHigh = EncoderConfig.forResolution(1920, 1080)
            .withFrameRate(120) // Too high

        assertThat(configLow.frameRate).isAtLeast(15)
        assertThat(configHigh.frameRate).isAtMost(60)
    }

    @Test
    fun `calculates I-frame interval`() {
        val config = EncoderConfig.forResolution(1920, 1080)

        // I-frame every 1 second for good seeking
        assertThat(config.iFrameIntervalSeconds).isEqualTo(1)
    }

    @ParameterizedTest
    @CsvSource(
        "1920, 1080, 4000000",
        "1280, 720, 2500000",
        "2560, 1440, 8000000",
        "3840, 2160, 16000000"
    )
    fun `calculates appropriate bitrate for resolution`(
        width: Int,
        height: Int,
        expectedBitrate: Int
    ) {
        val config = EncoderConfig.forResolution(width, height)

        assertThat(config.bitrate).isEqualTo(expectedBitrate)
    }

    @Test
    fun `ensures dimensions are even numbers for encoder compatibility`() {
        // Odd dimensions can cause encoding issues
        val config = EncoderConfig.forResolution(1919, 1079)

        assertThat(config.width % 2).isEqualTo(0)
        assertThat(config.height % 2).isEqualTo(0)
    }

    @Test
    fun `provides color format for encoder`() {
        val config = EncoderConfig.forResolution(1920, 1080)

        assertThat(config.colorFormat).isEqualTo(EncoderConfig.COLOR_FORMAT_YUV420_FLEXIBLE)
    }

    @Test
    fun `creates copy with modified values`() {
        val original = EncoderConfig.forResolution(1920, 1080)
        val modified = original.withMaxBitrate(2_000_000).withFrameRate(24)

        // Original should be unchanged
        assertThat(original.bitrate).isEqualTo(4_000_000)
        assertThat(original.frameRate).isEqualTo(30)

        // Modified should have new values
        assertThat(modified.bitrate).isAtMost(2_000_000)
        assertThat(modified.frameRate).isEqualTo(24)
    }
}
