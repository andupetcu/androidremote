package com.androidremote.transport

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Wrapper around DataChannelInterface for sending video frames.
 *
 * Supports two wire formats:
 *
 * **Single-frame** (total size <= MAX_SINGLE_MESSAGE):
 * - Byte 0: flags (bit 0 = keyframe, bit 7 = 0)
 * - Bytes 1-8: presentation timestamp (big-endian microseconds)
 * - Bytes 9+: frame data
 *
 * **Chunked frame** (total size > MAX_SINGLE_MESSAGE):
 * - Byte 0: 0x80 | flags (bit 7 = 1 marks chunk)
 * - Bytes 1-8: presentation timestamp (frame ID for reassembly)
 * - Bytes 9-10: chunk index (uint16 big-endian)
 * - Bytes 11-12: total chunk count (uint16 big-endian)
 * - Bytes 13+: chunk payload
 */
class VideoChannel(private val dataChannel: DataChannelInterface) {

    companion object {
        private const val HEADER_SIZE = 9 // 1 byte flags + 8 bytes timestamp
        private const val CHUNK_HEADER_SIZE = 13 // flags(1) + timestamp(8) + index(2) + total(2)
        private const val FLAG_KEYFRAME: Byte = 0x01
        private const val FLAG_CHUNKED: Int = 0x80

        /** Max H.264 payload per chunk. Keeps total message under 4KB for SCTP compatibility. */
        private const val CHUNK_PAYLOAD_SIZE = 4000

        /** Frames larger than this (including header) get chunked. */
        private const val MAX_SINGLE_MESSAGE = CHUNK_PAYLOAD_SIZE + HEADER_SIZE
    }

    private var sendCount = 0
    private var failCount = 0

    /**
     * Send a video frame over the data channel, chunking if necessary.
     *
     * @param data The encoded frame data (H.264 NAL units)
     * @param presentationTimeUs Presentation timestamp in microseconds
     * @param isKeyFrame True if this is a keyframe (I-frame)
     * @return True if all data sent successfully, false otherwise
     */
    fun sendFrame(data: ByteArray, presentationTimeUs: Long, isKeyFrame: Boolean): Boolean {
        val totalPacketSize = HEADER_SIZE + data.size
        sendCount++

        return if (totalPacketSize <= MAX_SINGLE_MESSAGE) {
            sendSingle(data, presentationTimeUs, isKeyFrame)
        } else {
            sendChunked(data, presentationTimeUs, isKeyFrame)
        }
    }

    private fun sendSingle(data: ByteArray, ts: Long, isKeyFrame: Boolean): Boolean {
        val packet = ByteArray(HEADER_SIZE + data.size)
        packet[0] = if (isKeyFrame) FLAG_KEYFRAME else 0
        ByteBuffer.wrap(packet, 1, 8).order(ByteOrder.BIG_ENDIAN).putLong(ts)
        System.arraycopy(data, 0, packet, HEADER_SIZE, data.size)

        val result = dataChannel.send(packet)
        if (!result) {
            failCount++
            System.err.println("VideoChannel: SEND FAILED #$failCount/$sendCount, size=${packet.size}, key=$isKeyFrame")
        } else if (sendCount <= 10 || sendCount % 100 == 0) {
            System.err.println("VideoChannel: sent #$sendCount, size=${packet.size}, key=$isKeyFrame")
        }
        return result
    }

    private fun sendChunked(data: ByteArray, ts: Long, isKeyFrame: Boolean): Boolean {
        val totalChunks = (data.size + CHUNK_PAYLOAD_SIZE - 1) / CHUNK_PAYLOAD_SIZE
        val flagsByte = FLAG_CHUNKED or (if (isKeyFrame) FLAG_KEYFRAME.toInt() else 0)
        var allSent = true

        for (i in 0 until totalChunks) {
            val offset = i * CHUNK_PAYLOAD_SIZE
            val chunkLen = minOf(CHUNK_PAYLOAD_SIZE, data.size - offset)
            val packet = ByteArray(CHUNK_HEADER_SIZE + chunkLen)

            packet[0] = flagsByte.toByte()
            ByteBuffer.wrap(packet, 1, 8).order(ByteOrder.BIG_ENDIAN).putLong(ts)
            ByteBuffer.wrap(packet, 9, 4).order(ByteOrder.BIG_ENDIAN)
                .putShort(i.toShort())
                .putShort(totalChunks.toShort())
            System.arraycopy(data, offset, packet, CHUNK_HEADER_SIZE, chunkLen)

            if (!dataChannel.send(packet)) {
                failCount++
                allSent = false
                System.err.println("VideoChannel: CHUNK FAIL frame#$sendCount chunk $i/$totalChunks, size=${packet.size}")
                break // Don't send remaining chunks of a broken frame
            }
        }

        if (allSent && (sendCount <= 10 || sendCount % 100 == 0)) {
            System.err.println("VideoChannel: sent #$sendCount CHUNKED ${totalChunks}x, total=${data.size}, key=$isKeyFrame")
        }
        return allSent
    }

    /**
     * Check if the channel is open and ready to send.
     */
    val isOpen: Boolean
        get() = dataChannel.state == DataChannelState.OPEN
}
