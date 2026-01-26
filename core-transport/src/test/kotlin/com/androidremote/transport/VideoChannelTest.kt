package com.androidremote.transport

import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import io.mockk.verify
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

class VideoChannelTest {

    private lateinit var mockDataChannel: DataChannelInterface
    private lateinit var videoChannel: VideoChannel

    @BeforeEach
    fun setup() {
        mockDataChannel = mockk(relaxed = true)
        videoChannel = VideoChannel(mockDataChannel)
    }

    @Test
    fun `sendFrame packages frame with correct header format`() {
        val frameData = byteArrayOf(0x00, 0x00, 0x00, 0x01, 0x67) // NAL start + SPS
        val timestamp = 1234567890L
        val isKeyFrame = true

        val dataSlot = slot<ByteArray>()
        every { mockDataChannel.send(capture(dataSlot)) } returns true

        val result = videoChannel.sendFrame(frameData, timestamp, isKeyFrame)

        assertTrue(result)
        val sent = dataSlot.captured

        // Verify header: 1 byte flags + 8 bytes timestamp
        assertEquals(1 + 8 + frameData.size, sent.size)

        // Check flags byte (bit 0 = keyframe)
        assertEquals(0x01.toByte(), sent[0])

        // Check timestamp (big-endian)
        val buffer = ByteBuffer.wrap(sent, 1, 8).order(ByteOrder.BIG_ENDIAN)
        assertEquals(timestamp, buffer.getLong())

        // Check frame data
        assertArrayEquals(frameData, sent.copyOfRange(9, sent.size))
    }

    @Test
    fun `sendFrame sets keyframe flag correctly for non-keyframe`() {
        val frameData = byteArrayOf(0x00, 0x00, 0x00, 0x01, 0x41) // NAL start + non-IDR
        val dataSlot = slot<ByteArray>()
        every { mockDataChannel.send(capture(dataSlot)) } returns true

        videoChannel.sendFrame(frameData, 0L, isKeyFrame = false)

        assertEquals(0x00.toByte(), dataSlot.captured[0])
    }

    @Test
    fun `sendFrame returns false when channel send fails`() {
        every { mockDataChannel.send(any<ByteArray>()) } returns false

        val result = videoChannel.sendFrame(byteArrayOf(1, 2, 3), 0L, false)

        assertFalse(result)
    }

    @Test
    fun `isOpen returns true when channel state is OPEN`() {
        every { mockDataChannel.state } returns DataChannelState.OPEN
        assertTrue(videoChannel.isOpen)
    }

    @Test
    fun `isOpen returns false when channel state is not OPEN`() {
        every { mockDataChannel.state } returns DataChannelState.CONNECTING
        assertFalse(videoChannel.isOpen)

        every { mockDataChannel.state } returns DataChannelState.CLOSED
        assertFalse(videoChannel.isOpen)

        every { mockDataChannel.state } returns DataChannelState.CLOSING
        assertFalse(videoChannel.isOpen)
    }
}
