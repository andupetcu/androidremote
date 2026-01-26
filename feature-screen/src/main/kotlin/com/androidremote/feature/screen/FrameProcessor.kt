package com.androidremote.feature.screen

import java.util.zip.CRC32

/**
 * Raw frame data from screen capture.
 *
 * This is an abstraction over Android's Image class to enable unit testing.
 *
 * @property width Frame width in pixels
 * @property height Frame height in pixels
 * @property data Raw pixel data
 * @property timestampNs Capture timestamp in nanoseconds
 */
data class FrameData(
    val width: Int,
    val height: Int,
    val data: ByteArray,
    val timestampNs: Long
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (javaClass != other?.javaClass) return false
        other as FrameData
        return width == other.width &&
                height == other.height &&
                data.contentEquals(other.data) &&
                timestampNs == other.timestampNs
    }

    override fun hashCode(): Int {
        var result = width
        result = 31 * result + height
        result = 31 * result + data.contentHashCode()
        result = 31 * result + timestampNs.hashCode()
        return result
    }
}

/**
 * Processed frame ready for encoder input.
 *
 * @property width Frame width in pixels
 * @property height Frame height in pixels
 * @property data Processed pixel data in encoder-compatible format
 * @property presentationTimeUs Presentation timestamp in microseconds
 */
data class EncoderInput(
    val width: Int,
    val height: Int,
    val data: ByteArray,
    val presentationTimeUs: Long
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (javaClass != other?.javaClass) return false
        other as EncoderInput
        return width == other.width &&
                height == other.height &&
                data.contentEquals(other.data) &&
                presentationTimeUs == other.presentationTimeUs
    }

    override fun hashCode(): Int {
        var result = width
        result = 31 * result + height
        result = 31 * result + data.contentHashCode()
        result = 31 * result + presentationTimeUs.hashCode()
        return result
    }
}

/**
 * Statistics about frame processing.
 *
 * @property totalFrames Total frames received
 * @property processedFrames Frames that were encoded
 * @property skippedFrames Frames skipped (duplicates)
 * @property startTimeNs When statistics collection started
 */
data class FrameStatistics(
    val totalFrames: Long,
    val processedFrames: Long,
    val skippedFrames: Long,
    val startTimeNs: Long
) {
    /**
     * Calculate approximate FPS based on processed frames and elapsed time.
     */
    fun calculateFps(): Double {
        val elapsedNs = System.nanoTime() - startTimeNs
        if (elapsedNs <= 0 || processedFrames == 0L) return 0.0
        return processedFrames * 1_000_000_000.0 / elapsedNs
    }
}

/**
 * Processes raw frames from VirtualDisplay for encoder input.
 *
 * Handles:
 * - Converting frame data to encoder-compatible format
 * - Tracking presentation timestamps
 * - Detecting and optionally skipping duplicate frames
 * - Collecting frame statistics
 *
 * @param skipDuplicates Whether to skip frames with identical content
 */
class FrameProcessor(
    private val skipDuplicates: Boolean = true
) {
    private var lastFrameHash: Long = 0
    private var frameCount: Long = 0
    private var processedCount: Long = 0
    private var skippedCount: Long = 0
    private var startTimeNs: Long = System.nanoTime()
    private var firstFrameTimeNs: Long = 0

    /**
     * Processes a frame from screen capture.
     *
     * @param frameData Raw frame data, or null if no frame available
     * @return Encoder input if frame should be encoded, null if skipped or invalid
     */
    fun process(frameData: FrameData?): EncoderInput? {
        if (frameData == null) {
            return null
        }

        frameCount++

        // Calculate content hash for duplicate detection
        val currentHash = if (skipDuplicates) {
            calculateHash(frameData.data)
        } else {
            0L
        }

        // Check for duplicate
        if (skipDuplicates && currentHash == lastFrameHash && frameCount > 1) {
            skippedCount++
            return null
        }

        lastFrameHash = currentHash
        processedCount++

        // Track first frame time for presentation timestamp calculation
        if (firstFrameTimeNs == 0L) {
            firstFrameTimeNs = frameData.timestampNs
        }

        // Calculate presentation time in microseconds
        // Use frame timestamp difference, ensuring always positive and increasing
        val timeDeltaUs = (frameData.timestampNs - firstFrameTimeNs) / 1000
        // Ensure presentation time is always positive and increasing
        // Use processedCount as minimum to guarantee uniqueness even with same timestamps
        val presentationTimeUs = timeDeltaUs + processedCount

        return EncoderInput(
            width = frameData.width,
            height = frameData.height,
            data = frameData.data,
            presentationTimeUs = presentationTimeUs
        )
    }

    /**
     * Gets current frame processing statistics.
     */
    fun getStatistics(): FrameStatistics {
        return FrameStatistics(
            totalFrames = frameCount,
            processedFrames = processedCount,
            skippedFrames = skippedCount,
            startTimeNs = startTimeNs
        )
    }

    /**
     * Resets all statistics and state.
     */
    fun resetStatistics() {
        frameCount = 0
        processedCount = 0
        skippedCount = 0
        startTimeNs = System.nanoTime()
        firstFrameTimeNs = 0
        lastFrameHash = 0
    }

    /**
     * Calculates a hash of frame content for duplicate detection.
     * Uses CRC32 for fast hashing of potentially large frame data.
     */
    private fun calculateHash(data: ByteArray): Long {
        val crc = CRC32()
        crc.update(data)
        return crc.value
    }
}
