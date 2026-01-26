package com.androidremote.app.webrtc

import com.androidremote.transport.DataChannelObserver
import com.androidremote.transport.DataChannelState
import io.mockk.Runs
import io.mockk.every
import io.mockk.just
import io.mockk.mockk
import io.mockk.slot
import io.mockk.verify
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.webrtc.DataChannel
import java.nio.ByteBuffer

/**
 * Tests for WebRtcDataChannel.
 *
 * Uses MockK to mock the native DataChannel since WebRTC native
 * libraries are unavailable in unit tests.
 */
class WebRtcDataChannelTest {

    private lateinit var mockNativeChannel: DataChannel
    private lateinit var webRtcDataChannel: WebRtcDataChannel

    @BeforeEach
    fun setup() {
        mockNativeChannel = mockk(relaxed = true)
        webRtcDataChannel = WebRtcDataChannel(mockNativeChannel)
    }

    @Test
    fun `label returns native channel label`() {
        every { mockNativeChannel.label() } returns "test-channel"

        assertEquals("test-channel", webRtcDataChannel.label)
        verify { mockNativeChannel.label() }
    }

    @Test
    fun `state maps CONNECTING correctly`() {
        every { mockNativeChannel.state() } returns DataChannel.State.CONNECTING

        assertEquals(DataChannelState.CONNECTING, webRtcDataChannel.state)
    }

    @Test
    fun `state maps OPEN correctly`() {
        every { mockNativeChannel.state() } returns DataChannel.State.OPEN

        assertEquals(DataChannelState.OPEN, webRtcDataChannel.state)
    }

    @Test
    fun `state maps CLOSING correctly`() {
        every { mockNativeChannel.state() } returns DataChannel.State.CLOSING

        assertEquals(DataChannelState.CLOSING, webRtcDataChannel.state)
    }

    @Test
    fun `state maps CLOSED correctly`() {
        every { mockNativeChannel.state() } returns DataChannel.State.CLOSED

        assertEquals(DataChannelState.CLOSED, webRtcDataChannel.state)
    }

    @Test
    fun `send binary data calls native channel with binary flag`() {
        val bufferSlot = slot<DataChannel.Buffer>()
        every { mockNativeChannel.send(capture(bufferSlot)) } returns true

        val data = byteArrayOf(0x01, 0x02, 0x03, 0x04)
        val result = webRtcDataChannel.send(data)

        assertTrue(result)
        assertTrue(bufferSlot.captured.binary)

        val capturedData = ByteArray(bufferSlot.captured.data.remaining())
        bufferSlot.captured.data.get(capturedData)
        assertTrue(data.contentEquals(capturedData))
    }

    @Test
    fun `send text data calls native channel without binary flag`() {
        val bufferSlot = slot<DataChannel.Buffer>()
        every { mockNativeChannel.send(capture(bufferSlot)) } returns true

        val text = "Hello, World!"
        val result = webRtcDataChannel.send(text)

        assertTrue(result)
        assertFalse(bufferSlot.captured.binary)

        val capturedData = ByteArray(bufferSlot.captured.data.remaining())
        bufferSlot.captured.data.get(capturedData)
        assertEquals(text, String(capturedData, Charsets.UTF_8))
    }

    @Test
    fun `send returns false when native channel fails`() {
        every { mockNativeChannel.send(any()) } returns false

        val result = webRtcDataChannel.send(byteArrayOf(0x01))

        assertFalse(result)
    }

    @Test
    fun `close calls native channel close`() {
        every { mockNativeChannel.close() } just Runs

        webRtcDataChannel.close()

        verify { mockNativeChannel.close() }
    }

    @Test
    fun `setObserver registers observer on native channel`() {
        val observerSlot = slot<DataChannel.Observer>()
        every { mockNativeChannel.registerObserver(capture(observerSlot)) } just Runs

        val observer = mockk<DataChannelObserver>(relaxed = true)
        webRtcDataChannel.setObserver(observer)

        verify { mockNativeChannel.registerObserver(any()) }
    }

    @Test
    fun `observer onStateChange is forwarded`() {
        val nativeObserverSlot = slot<DataChannel.Observer>()
        every { mockNativeChannel.registerObserver(capture(nativeObserverSlot)) } just Runs
        every { mockNativeChannel.state() } returns DataChannel.State.OPEN

        val observer = mockk<DataChannelObserver>(relaxed = true)
        webRtcDataChannel.setObserver(observer)

        // Trigger the state change callback
        nativeObserverSlot.captured.onStateChange()

        verify { observer.onStateChange(DataChannelState.OPEN) }
    }

    @Test
    fun `observer onMessage with binary data is forwarded`() {
        val nativeObserverSlot = slot<DataChannel.Observer>()
        every { mockNativeChannel.registerObserver(capture(nativeObserverSlot)) } just Runs

        val observer = mockk<DataChannelObserver>(relaxed = true)
        webRtcDataChannel.setObserver(observer)

        // Create binary buffer
        val data = byteArrayOf(0x10, 0x20, 0x30)
        val buffer = DataChannel.Buffer(ByteBuffer.wrap(data), true)

        // Trigger the message callback
        nativeObserverSlot.captured.onMessage(buffer)

        val dataSlot = slot<ByteArray>()
        verify { observer.onMessage(capture(dataSlot)) }
        assertTrue(data.contentEquals(dataSlot.captured))
    }

    @Test
    fun `observer onMessage with text data is forwarded`() {
        val nativeObserverSlot = slot<DataChannel.Observer>()
        every { mockNativeChannel.registerObserver(capture(nativeObserverSlot)) } just Runs

        val observer = mockk<DataChannelObserver>(relaxed = true)
        webRtcDataChannel.setObserver(observer)

        // Create text buffer
        val text = "Test message"
        val buffer = DataChannel.Buffer(ByteBuffer.wrap(text.toByteArray(Charsets.UTF_8)), false)

        // Trigger the message callback
        nativeObserverSlot.captured.onMessage(buffer)

        val textSlot = slot<String>()
        verify { observer.onMessage(capture(textSlot)) }
        assertEquals(text, textSlot.captured)
    }

    @Test
    fun `toWebRtcState maps all states correctly`() {
        assertEquals(DataChannel.State.CONNECTING, WebRtcDataChannel.toWebRtcState(DataChannelState.CONNECTING))
        assertEquals(DataChannel.State.OPEN, WebRtcDataChannel.toWebRtcState(DataChannelState.OPEN))
        assertEquals(DataChannel.State.CLOSING, WebRtcDataChannel.toWebRtcState(DataChannelState.CLOSING))
        assertEquals(DataChannel.State.CLOSED, WebRtcDataChannel.toWebRtcState(DataChannelState.CLOSED))
    }

    @Test
    fun `send handles UTF-8 special characters`() {
        val bufferSlot = slot<DataChannel.Buffer>()
        every { mockNativeChannel.send(capture(bufferSlot)) } returns true

        val text = "Hello \u4e16\u754c \u263a" // "Hello World" with Chinese characters and emoji
        webRtcDataChannel.send(text)

        val capturedData = ByteArray(bufferSlot.captured.data.remaining())
        bufferSlot.captured.data.get(capturedData)
        assertEquals(text, String(capturedData, Charsets.UTF_8))
    }

    @Test
    fun `send handles empty data`() {
        val bufferSlot = slot<DataChannel.Buffer>()
        every { mockNativeChannel.send(capture(bufferSlot)) } returns true

        webRtcDataChannel.send(byteArrayOf())

        assertEquals(0, bufferSlot.captured.data.remaining())
    }

    @Test
    fun `send handles empty text`() {
        val bufferSlot = slot<DataChannel.Buffer>()
        every { mockNativeChannel.send(capture(bufferSlot)) } returns true

        webRtcDataChannel.send("")

        assertEquals(0, bufferSlot.captured.data.remaining())
    }
}
