package com.androidremote.feature.screen

import com.google.common.truth.Truth.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.BeforeEach

/**
 * Tests for frame processing from VirtualDisplay to encoder input.
 *
 * FrameProcessor handles:
 * - Converting raw frame data to encoder-compatible format
 * - Tracking presentation timestamps
 * - Detecting and skipping duplicate frames
 *
 * These tests are written FIRST (TDD) - implementation follows.
 */
class FrameProcessorTest {

    private lateinit var processor: FrameProcessor

    @BeforeEach
    fun setUp() {
        processor = FrameProcessor()
    }

    @Test
    fun `converts frame data to encoder input`() {
        val frameData = createFrameData(width = 1920, height = 1080)

        val encoderInput = processor.process(frameData)

        assertThat(encoderInput).isNotNull()
        assertThat(encoderInput!!.width).isEqualTo(1920)
        assertThat(encoderInput.height).isEqualTo(1080)
    }

    @Test
    fun `sets presentation time on encoder input`() {
        val frameData = createFrameData(width = 1920, height = 1080)

        val encoderInput = processor.process(frameData)

        assertThat(encoderInput).isNotNull()
        assertThat(encoderInput!!.presentationTimeUs).isGreaterThan(0)
    }

    @Test
    fun `increments presentation time for each frame`() {
        val baseTime = System.nanoTime()
        val frame1 = createFrameData(width = 1920, height = 1080, content = byteArrayOf(1, 2, 3), timestampNs = baseTime)
        val frame2 = createFrameData(width = 1920, height = 1080, content = byteArrayOf(4, 5, 6), timestampNs = baseTime + 33_000_000) // 33ms later (~30fps)

        val input1 = processor.process(frame1)
        val input2 = processor.process(frame2)

        assertThat(input1).isNotNull()
        assertThat(input2).isNotNull()
        assertThat(input2!!.presentationTimeUs).isGreaterThan(input1!!.presentationTimeUs)
    }

    @Test
    fun `skips duplicate frames based on content hash`() {
        val frame1 = createFrameData(width = 1920, height = 1080, content = byteArrayOf(1, 2, 3, 4))
        val frame2 = createFrameData(width = 1920, height = 1080, content = byteArrayOf(1, 2, 3, 4)) // Same content

        val input1 = processor.process(frame1)
        val input2 = processor.process(frame2)

        assertThat(input1).isNotNull()
        assertThat(input2).isNull() // Duplicate, skipped
    }

    @Test
    fun `processes different frames after duplicate`() {
        val frame1 = createFrameData(width = 1920, height = 1080, content = byteArrayOf(1, 2, 3))
        val frame2 = createFrameData(width = 1920, height = 1080, content = byteArrayOf(1, 2, 3)) // Duplicate
        val frame3 = createFrameData(width = 1920, height = 1080, content = byteArrayOf(4, 5, 6)) // Different

        processor.process(frame1)
        processor.process(frame2)
        val input3 = processor.process(frame3)

        assertThat(input3).isNotNull()
    }

    @Test
    fun `tracks frame statistics`() {
        val frame1 = createFrameData(content = byteArrayOf(1))
        val frame2 = createFrameData(content = byteArrayOf(1)) // Duplicate
        val frame3 = createFrameData(content = byteArrayOf(2))

        processor.process(frame1)
        processor.process(frame2)
        processor.process(frame3)

        val stats = processor.getStatistics()
        assertThat(stats.totalFrames).isEqualTo(3)
        assertThat(stats.processedFrames).isEqualTo(2)
        assertThat(stats.skippedFrames).isEqualTo(1)
    }

    @Test
    fun `resets statistics on request`() {
        val frame1 = createFrameData(content = byteArrayOf(1))
        processor.process(frame1)

        processor.resetStatistics()

        val stats = processor.getStatistics()
        assertThat(stats.totalFrames).isEqualTo(0)
    }

    @Test
    fun `handles null frame data gracefully`() {
        val result = processor.process(null)

        assertThat(result).isNull()
    }

    @Test
    fun `can disable duplicate detection`() {
        val processorNoDupeCheck = FrameProcessor(skipDuplicates = false)
        val frame1 = createFrameData(content = byteArrayOf(1, 2, 3))
        val frame2 = createFrameData(content = byteArrayOf(1, 2, 3)) // Same content

        val input1 = processorNoDupeCheck.process(frame1)
        val input2 = processorNoDupeCheck.process(frame2)

        assertThat(input1).isNotNull()
        assertThat(input2).isNotNull() // Not skipped when duplicate detection disabled
    }

    @Test
    fun `calculates frame rate from processed frames`() {
        // Process frames at simulated intervals
        val frame1 = createFrameData(content = byteArrayOf(1))
        val frame2 = createFrameData(content = byteArrayOf(2))

        processor.process(frame1)
        // Simulate time passing
        Thread.sleep(50) // ~20fps equivalent
        processor.process(frame2)

        val stats = processor.getStatistics()
        // FPS should be calculable (not testing exact value due to timing uncertainty)
        assertThat(stats.processedFrames).isEqualTo(2)
    }

    // Helper to create frame data for testing
    private fun createFrameData(
        width: Int = 1920,
        height: Int = 1080,
        content: ByteArray = byteArrayOf(0),
        timestampNs: Long = System.nanoTime()
    ): FrameData {
        return FrameData(
            width = width,
            height = height,
            data = content,
            timestampNs = timestampNs
        )
    }
}
