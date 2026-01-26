package com.androidremote.feature.screen

import com.google.common.truth.Truth.assertThat
import org.junit.jupiter.api.Test

/**
 * Tests for EncodedFrame data class.
 *
 * EncodedFrame represents encoded H.264 video frames from the encoder,
 * containing the raw encoded data along with timing and frame type information.
 */
class EncodedFrameTest {

    @Test
    fun `creates encoded frame with data and metadata`() {
        val data = byteArrayOf(0x00, 0x00, 0x00, 0x01, 0x67) // Sample NAL unit header
        val presentationTimeUs = 33333L // ~30fps

        val frame = EncodedFrame(
            data = data,
            presentationTimeUs = presentationTimeUs,
            isKeyFrame = true
        )

        assertThat(frame.data).isEqualTo(data)
        assertThat(frame.presentationTimeUs).isEqualTo(presentationTimeUs)
        assertThat(frame.isKeyFrame).isTrue()
    }

    @Test
    fun `size property returns data length`() {
        val data = byteArrayOf(1, 2, 3, 4, 5)
        val frame = EncodedFrame(data, 0L, false)

        assertThat(frame.size).isEqualTo(5)
    }

    @Test
    fun `size property returns zero for empty data`() {
        val frame = EncodedFrame(byteArrayOf(), 0L, false)

        assertThat(frame.size).isEqualTo(0)
    }

    @Test
    fun `fromBufferInfo creates keyframe when flag is set`() {
        val data = byteArrayOf(1, 2, 3)
        val flags = EncodedFrame.BUFFER_FLAG_KEY_FRAME // 1

        val frame = EncodedFrame.fromBufferInfo(data, 1000L, flags)

        assertThat(frame.isKeyFrame).isTrue()
        assertThat(frame.presentationTimeUs).isEqualTo(1000L)
    }

    @Test
    fun `fromBufferInfo creates non-keyframe when flag is not set`() {
        val data = byteArrayOf(1, 2, 3)
        val flags = 0 // No keyframe flag

        val frame = EncodedFrame.fromBufferInfo(data, 2000L, flags)

        assertThat(frame.isKeyFrame).isFalse()
    }

    @Test
    fun `fromBufferInfo handles combined flags correctly`() {
        val data = byteArrayOf(1, 2, 3)
        // Simulate multiple flags combined with keyframe flag
        val flags = EncodedFrame.BUFFER_FLAG_KEY_FRAME or 0x04 // Keyframe + end of stream

        val frame = EncodedFrame.fromBufferInfo(data, 3000L, flags)

        assertThat(frame.isKeyFrame).isTrue()
    }

    @Test
    fun `equals compares data content`() {
        val frame1 = EncodedFrame(byteArrayOf(1, 2, 3), 100L, true)
        val frame2 = EncodedFrame(byteArrayOf(1, 2, 3), 100L, true)
        val frame3 = EncodedFrame(byteArrayOf(1, 2, 4), 100L, true)

        assertThat(frame1).isEqualTo(frame2)
        assertThat(frame1).isNotEqualTo(frame3)
    }

    @Test
    fun `equals compares presentation time`() {
        val frame1 = EncodedFrame(byteArrayOf(1, 2, 3), 100L, true)
        val frame2 = EncodedFrame(byteArrayOf(1, 2, 3), 200L, true)

        assertThat(frame1).isNotEqualTo(frame2)
    }

    @Test
    fun `equals compares keyframe flag`() {
        val frame1 = EncodedFrame(byteArrayOf(1, 2, 3), 100L, true)
        val frame2 = EncodedFrame(byteArrayOf(1, 2, 3), 100L, false)

        assertThat(frame1).isNotEqualTo(frame2)
    }

    @Test
    fun `hashCode is consistent for equal frames`() {
        val frame1 = EncodedFrame(byteArrayOf(1, 2, 3), 100L, true)
        val frame2 = EncodedFrame(byteArrayOf(1, 2, 3), 100L, true)

        assertThat(frame1.hashCode()).isEqualTo(frame2.hashCode())
    }

    @Test
    fun `hashCode differs for different frames`() {
        val frame1 = EncodedFrame(byteArrayOf(1, 2, 3), 100L, true)
        val frame2 = EncodedFrame(byteArrayOf(4, 5, 6), 100L, true)

        // Note: Hash collision is possible but unlikely for different data
        assertThat(frame1.hashCode()).isNotEqualTo(frame2.hashCode())
    }

    @Test
    fun `toString includes useful information`() {
        val frame = EncodedFrame(byteArrayOf(1, 2, 3, 4, 5), 12345L, true)

        val string = frame.toString()

        assertThat(string).contains("5 bytes")
        assertThat(string).contains("12345")
        assertThat(string).contains("isKeyFrame=true")
    }

    @Test
    fun `toString for non-keyframe`() {
        val frame = EncodedFrame(byteArrayOf(1, 2), 500L, false)

        val string = frame.toString()

        assertThat(string).contains("isKeyFrame=false")
    }

    @Test
    fun `BUFFER_FLAG_KEY_FRAME constant matches MediaCodec value`() {
        // MediaCodec.BUFFER_FLAG_KEY_FRAME = 1
        assertThat(EncodedFrame.BUFFER_FLAG_KEY_FRAME).isEqualTo(1)
    }

    @Test
    fun `handles large frame data`() {
        val largeData = ByteArray(1024 * 1024) { it.toByte() } // 1MB
        val frame = EncodedFrame(largeData, 1000L, true)

        assertThat(frame.size).isEqualTo(1024 * 1024)
        assertThat(frame.data).hasLength(1024 * 1024)
    }

    @Test
    fun `preserves data reference`() {
        val data = byteArrayOf(1, 2, 3)
        val frame = EncodedFrame(data, 100L, true)

        // Data should be the same reference (not copied)
        assertThat(frame.data).isSameInstanceAs(data)
    }
}
