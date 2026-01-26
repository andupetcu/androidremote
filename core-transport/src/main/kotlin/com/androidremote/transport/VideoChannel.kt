package com.androidremote.transport

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Wrapper around DataChannelInterface for sending video frames.
 *
 * Adds a simple header to each frame:
 * - 1 byte: flags (bit 0 = keyframe)
 * - 8 bytes: presentation timestamp (big-endian microseconds)
 * - N bytes: frame data
 */
class VideoChannel(private val dataChannel: DataChannelInterface) {

    companion object {
        private const val HEADER_SIZE = 9 // 1 byte flags + 8 bytes timestamp
        private const val FLAG_KEYFRAME: Byte = 0x01
    }

    /**
     * Send a video frame over the data channel.
     *
     * @param data The encoded frame data (H.264 NAL units)
     * @param presentationTimeUs Presentation timestamp in microseconds
     * @param isKeyFrame True if this is a keyframe (I-frame)
     * @return True if sent successfully, false otherwise
     */
    fun sendFrame(data: ByteArray, presentationTimeUs: Long, isKeyFrame: Boolean): Boolean {
        val packet = ByteArray(HEADER_SIZE + data.size)

        // Flags byte
        packet[0] = if (isKeyFrame) FLAG_KEYFRAME else 0

        // Timestamp (big-endian)
        ByteBuffer.wrap(packet, 1, 8)
            .order(ByteOrder.BIG_ENDIAN)
            .putLong(presentationTimeUs)

        // Frame data
        System.arraycopy(data, 0, packet, HEADER_SIZE, data.size)

        return dataChannel.send(packet)
    }

    /**
     * Check if the channel is open and ready to send.
     */
    val isOpen: Boolean
        get() = dataChannel.state == DataChannelState.OPEN
}
