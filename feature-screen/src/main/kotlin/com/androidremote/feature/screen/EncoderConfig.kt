package com.androidremote.feature.screen

/**
 * Configuration for video encoding of screen capture.
 *
 * Determines optimal encoding parameters based on resolution, bandwidth
 * constraints, and device rotation. Ensures compatibility with MediaCodec
 * by enforcing constraints like even dimensions.
 *
 * @property width Output video width in pixels (always even)
 * @property height Output video height in pixels (always even)
 * @property bitrate Target bitrate in bits per second
 * @property frameRate Target frame rate in fps
 * @property mimeType Video codec MIME type (default: H.264/AVC)
 * @property iFrameIntervalSeconds Interval between I-frames for seeking
 * @property colorFormat Color format for encoder input
 */
data class EncoderConfig(
    val width: Int,
    val height: Int,
    val bitrate: Int,
    val frameRate: Int,
    val mimeType: String = MIME_TYPE_AVC,
    val iFrameIntervalSeconds: Int = DEFAULT_I_FRAME_INTERVAL,
    val colorFormat: Int = COLOR_FORMAT_YUV420_FLEXIBLE
) {
    init {
        require(width > 0 && width % 2 == 0) { "Width must be positive and even" }
        require(height > 0 && height % 2 == 0) { "Height must be positive and even" }
        require(bitrate > 0) { "Bitrate must be positive" }
        require(frameRate in MIN_FRAME_RATE..MAX_FRAME_RATE) { "Frame rate must be between $MIN_FRAME_RATE and $MAX_FRAME_RATE" }
    }

    /**
     * Creates a new config with a maximum bitrate constraint.
     * May scale down resolution to meet the bandwidth limit.
     */
    fun withMaxBitrate(maxBitrate: Int): EncoderConfig {
        if (bitrate <= maxBitrate) {
            return copy(bitrate = minOf(bitrate, maxBitrate))
        }

        // Need to scale down - find appropriate resolution
        val scaleFactor = kotlin.math.sqrt(maxBitrate.toDouble() / bitrate)
        val newWidth = roundToEven((width * scaleFactor).toInt())
        val newHeight = roundToEven((height * scaleFactor).toInt())
        val newBitrate = calculateBitrate(newWidth, newHeight)

        return copy(
            width = newWidth,
            height = newHeight,
            bitrate = minOf(newBitrate, maxBitrate)
        )
    }

    /**
     * Creates a new config with a different frame rate.
     * Frame rate is clamped to valid range.
     */
    fun withFrameRate(fps: Int): EncoderConfig {
        return copy(frameRate = fps.coerceIn(MIN_FRAME_RATE, MAX_FRAME_RATE))
    }

    companion object {
        const val MIME_TYPE_AVC = "video/avc"
        const val COLOR_FORMAT_YUV420_FLEXIBLE = 0x7F420888 // MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible

        const val DEFAULT_FRAME_RATE = 30
        const val MIN_FRAME_RATE = 15
        const val MAX_FRAME_RATE = 60
        const val DEFAULT_I_FRAME_INTERVAL = 1

        // Bitrate calculation constants (bits per pixel per second)
        private const val BITRATE_FACTOR_1080P = 1.93f  // Results in ~4 Mbps for 1080p at 30fps
        private const val BITRATE_FACTOR_720P = 2.41f   // Results in ~2.5 Mbps for 720p at 30fps

        /**
         * Creates an encoder config for the given resolution.
         *
         * @param width Screen width in pixels
         * @param height Screen height in pixels
         * @param rotation Device rotation in degrees (0, 90, 180, 270)
         * @return Configured encoder settings
         */
        fun forResolution(width: Int, height: Int, rotation: Int = 0): EncoderConfig {
            // Handle rotation - swap dimensions for 90/270 degrees
            val (outputWidth, outputHeight) = when (rotation) {
                90, 270 -> height to width
                else -> width to height
            }

            // Ensure dimensions are even
            val evenWidth = roundToEven(outputWidth)
            val evenHeight = roundToEven(outputHeight)

            val bitrate = calculateBitrate(evenWidth, evenHeight)

            return EncoderConfig(
                width = evenWidth,
                height = evenHeight,
                bitrate = bitrate,
                frameRate = DEFAULT_FRAME_RATE
            )
        }

        /**
         * Calculates appropriate bitrate based on resolution.
         * Uses standard recommendations for H.264 encoding quality.
         */
        private fun calculateBitrate(width: Int, height: Int): Int {
            val pixels = width * height

            return when {
                pixels >= 3840 * 2160 -> 16_000_000  // 4K: 16 Mbps
                pixels >= 2560 * 1440 -> 8_000_000   // 1440p: 8 Mbps
                pixels >= 1920 * 1080 -> 4_000_000   // 1080p: 4 Mbps
                pixels >= 1280 * 720 -> 2_500_000    // 720p: 2.5 Mbps
                pixels >= 854 * 480 -> 1_500_000    // 480p: 1.5 Mbps
                else -> 1_000_000                    // Lower: 1 Mbps
            }
        }

        /**
         * Rounds a dimension to the nearest even number.
         * Required for H.264 encoder compatibility (16x16 macroblocks).
         */
        private fun roundToEven(value: Int): Int {
            return if (value % 2 == 0) value else value + 1
        }
    }
}
