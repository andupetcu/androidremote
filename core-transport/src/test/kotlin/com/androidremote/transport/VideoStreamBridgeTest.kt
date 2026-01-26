package com.androidremote.transport

import io.mockk.*
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

@OptIn(ExperimentalCoroutinesApi::class)
class VideoStreamBridgeTest {

    private lateinit var mockVideoChannel: VideoChannel
    private lateinit var framesFlow: MutableSharedFlow<FrameData>

    @BeforeEach
    fun setup() {
        mockVideoChannel = mockk(relaxed = true)
        framesFlow = MutableSharedFlow(replay = 0, extraBufferCapacity = 64)
        every { mockVideoChannel.isOpen } returns true
    }

    @Test
    fun `start collects frames and sends via channel`() = runTest(UnconfinedTestDispatcher()) {
        val bridge = VideoStreamBridge(mockVideoChannel, framesFlow, this)
        every { mockVideoChannel.sendFrame(any(), any(), any()) } returns true

        bridge.start()

        val frame = FrameData(
            data = byteArrayOf(0x00, 0x00, 0x00, 0x01, 0x67),
            presentationTimeUs = 1000L,
            isKeyFrame = true
        )
        framesFlow.emit(frame)

        verify {
            mockVideoChannel.sendFrame(
                frame.data,
                frame.presentationTimeUs,
                frame.isKeyFrame
            )
        }

        bridge.stop()
    }

    @Test
    fun `stop cancels frame collection`() = runTest(UnconfinedTestDispatcher()) {
        val bridge = VideoStreamBridge(mockVideoChannel, framesFlow, this)
        every { mockVideoChannel.sendFrame(any(), any(), any()) } returns true

        bridge.start()
        bridge.stop()

        assertFalse(bridge.isRunning)

        // Emit frame after stop - should not be sent
        clearMocks(mockVideoChannel, answers = false)
        framesFlow.emit(FrameData(byteArrayOf(1), 0L, false))

        verify(exactly = 0) { mockVideoChannel.sendFrame(any(), any(), any()) }
    }

    @Test
    fun `isRunning reflects bridge state`() = runTest(UnconfinedTestDispatcher()) {
        val bridge = VideoStreamBridge(mockVideoChannel, framesFlow, this)

        assertFalse(bridge.isRunning)

        bridge.start()
        assertTrue(bridge.isRunning)

        bridge.stop()
        assertFalse(bridge.isRunning)
    }

    @Test
    fun `continues sending after channel failure`() = runTest(UnconfinedTestDispatcher()) {
        val bridge = VideoStreamBridge(mockVideoChannel, framesFlow, this)

        // First send fails, second succeeds
        every { mockVideoChannel.sendFrame(any(), any(), any()) } returns false andThen true

        bridge.start()

        framesFlow.emit(FrameData(byteArrayOf(1), 100L, false))
        framesFlow.emit(FrameData(byteArrayOf(2), 200L, true))

        // Both frames should be attempted
        verify(exactly = 2) { mockVideoChannel.sendFrame(any(), any(), any()) }

        bridge.stop()
    }

    @Test
    fun `start is idempotent when already running`() = runTest(UnconfinedTestDispatcher()) {
        val bridge = VideoStreamBridge(mockVideoChannel, framesFlow, this)
        every { mockVideoChannel.sendFrame(any(), any(), any()) } returns true

        bridge.start()
        bridge.start() // Second start should be ignored

        assertTrue(bridge.isRunning)

        // Emit frame - should only be processed once
        framesFlow.emit(FrameData(byteArrayOf(1), 100L, false))

        verify(exactly = 1) { mockVideoChannel.sendFrame(any(), any(), any()) }

        bridge.stop()
    }
}
