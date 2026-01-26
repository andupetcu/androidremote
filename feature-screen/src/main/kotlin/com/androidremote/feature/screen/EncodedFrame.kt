package com.androidremote.feature.screen

/**
 * Represents an encoded video frame from the H.264 encoder.
 *
 * Contains the raw encoded data along with timing and frame type information
 * needed for WebRTC transmission.
 *
 * @property data Raw encoded H.264 data (NAL units)
 * @property presentationTimeUs Presentation timestamp in microseconds
 * @property isKeyFrame True if this is an I-frame (keyframe), false for P/B-frames
 */
data class EncodedFrame(
    val data: ByteArray,
    val presentationTimeUs: Long,
    val isKeyFrame: Boolean
) {
    /**
     * Size of the encoded data in bytes.
     */
    val size: Int
        get() = data.size

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (javaClass != other?.javaClass) return false
        other as EncodedFrame
        return data.contentEquals(other.data) &&
                presentationTimeUs == other.presentationTimeUs &&
                isKeyFrame == other.isKeyFrame
    }

    override fun hashCode(): Int {
        var result = data.contentHashCode()
        result = 31 * result + presentationTimeUs.hashCode()
        result = 31 * result + isKeyFrame.hashCode()
        return result
    }

    override fun toString(): String {
        return "EncodedFrame(size=$size bytes, presentationTimeUs=$presentationTimeUs, isKeyFrame=$isKeyFrame)"
    }

    companion object {
        /**
         * Creates an EncodedFrame from encoder output buffer info.
         *
         * @param data Encoded data from output buffer
         * @param presentationTimeUs Presentation timestamp from BufferInfo
         * @param flags Buffer flags from BufferInfo
         * @return EncodedFrame with appropriate keyframe detection
         */
        fun fromBufferInfo(
            data: ByteArray,
            presentationTimeUs: Long,
            flags: Int
        ): EncodedFrame {
            // MediaCodec.BUFFER_FLAG_KEY_FRAME = 1
            val isKeyFrame = (flags and BUFFER_FLAG_KEY_FRAME) != 0
            return EncodedFrame(data, presentationTimeUs, isKeyFrame)
        }

        /**
         * MediaCodec.BUFFER_FLAG_KEY_FRAME value.
         * Defined here to avoid Android dependency in pure data class.
         */
        const val BUFFER_FLAG_KEY_FRAME = 1
    }
}
