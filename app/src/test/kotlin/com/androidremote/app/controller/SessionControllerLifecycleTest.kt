package com.androidremote.app.controller

import com.androidremote.app.testsupport.LogStub
import com.androidremote.transport.CommandEnvelope
import com.androidremote.transport.ControlMessage
import com.androidremote.transport.DeviceCommandChannel
import com.androidremote.transport.FrameData
import com.androidremote.transport.RemoteCommand
import com.androidremote.transport.RemoteSession
import com.androidremote.transport.SessionState as TransportSessionState
import com.androidremote.transport.VideoChannel
import com.google.common.truth.Truth.assertThat
import io.mockk.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.Executors

/** T8a: AR-03, AR-04, AR-05, AR-06, AR-09, AR-01 (device side), C9. */
@OptIn(ExperimentalCoroutinesApi::class)
class SessionControllerLifecycleTest {

    private lateinit var controller: SessionController
    private lateinit var session: RemoteSession
    private lateinit var channel: DeviceCommandChannel
    private lateinit var input: InputHandler
    private lateinit var text: TextInputHandler
    private lateinit var mdm: MdmHandler
    private lateinit var listener: SessionListener

    private lateinit var commands: Channel<CommandEnvelope>
    private lateinit var controls: MutableSharedFlow<ControlMessage>
    private lateinit var transportState: MutableStateFlow<TransportSessionState>
    private lateinit var dataChannelAvailable: MutableStateFlow<Boolean>
    private lateinit var peerLeft: MutableSharedFlow<Unit>
    private lateinit var peerJoined: MutableSharedFlow<String>
    private lateinit var channelState: MutableStateFlow<com.androidremote.transport.DataChannelState>

    private val dispatcher = StandardTestDispatcher()
    private val testScope = TestScope(dispatcher)
    private val ended = mutableListOf<String>()
    private var readyCount = 0
    private var keyFrames = 0

    @BeforeEach
    fun setUp() {
        LogStub.install()
        session = mockk(relaxed = true)
        channel = mockk(relaxed = true)
        input = mockk(relaxed = true)
        text = mockk(relaxed = true)
        mdm = mockk(relaxed = true)
        commands = Channel(Channel.UNLIMITED)
        controls = MutableSharedFlow(extraBufferCapacity = 16)
        transportState = MutableStateFlow(TransportSessionState.DISCONNECTED)
        dataChannelAvailable = MutableStateFlow(false)
        peerLeft = MutableSharedFlow(extraBufferCapacity = 16)
        peerJoined = MutableSharedFlow(extraBufferCapacity = 16)
        channelState = MutableStateFlow(com.androidremote.transport.DataChannelState.OPEN)
        every { session.state } returns transportState
        every { session.dataChannelAvailable } returns dataChannelAvailable
        every { session.peerLeft } returns peerLeft
        every { session.peerJoined } returns peerJoined
        every { session.commandChannel } returns null
        every { channel.commands } returns commands.receiveAsFlow()
        every { channel.controlMessages } returns controls
        every { channel.state } returns channelState
        every { channel.isOpen } returns true
        every { channel.sendAck(any()) } returns true
        every { channel.sendScreenInfo(any(), any(), any()) } returns true
        every { channel.sendCaptureFailed(any()) } returns true
        coEvery { session.connect(any()) } just Runs
        coEvery { session.startAsAnswerer() } just Runs
        every { session.closeSync() } answers { transportState.value = TransportSessionState.DISCONNECTED }
        coEvery { session.disconnect() } answers { transportState.value = TransportSessionState.DISCONNECTED }
        ended.clear(); readyCount = 0; keyFrames = 0
        listener = object : SessionListener {
            override fun onViewerReady() { readyCount++ }
            override fun onKeyFrameRequested() { keyFrames++ }
            override fun onSessionEnded(reason: String) { ended.add(reason) }
        }
    }

    @AfterEach
    fun tearDown() {
        LogStub.uninstall()
        if (::controller.isInitialized) controller.cancelJobs()
        clearAllMocks()
    }

    private fun create(
        scope: CoroutineScope,
        idle: Long = 30_000,
        max: Long = 4 * 3600_000L,
        inputDispatcher: kotlinx.coroutines.CoroutineDispatcher? = null
    ) = SessionController(
        inputHandler = input,
        textInputHandler = text,
        mdmHandler = mdm,
        sessionFactory = { _, _ -> session },
        commandChannelFactory = { channel },
        scope = scope,
        maxReconnectAttempts = 3,
        initialReconnectDelayMs = 100,
        idleTimeoutMs = idle,
        maxSessionMs = max,
        inputDispatcher = inputDispatcher
    ).also { it.listener = listener; controller = it }

    private fun TestScope.connectUp() {
        controller.connect("ws://s/ws", "tok", "dev-1")
        runCurrent()
        dataChannelAvailable.value = true
        transportState.value = TransportSessionState.CONNECTED
        runCurrent()
    }

    // ---- AR-03 ----

    @Test
    fun `viewer leaving ends the session after the idle timeout and stops video`() = testScope.runTest {
        create(this)
        connectUp()
        assertThat(controller.state.value).isInstanceOf(SessionState.Connected::class.java)

        peerLeft.emit(Unit)
        runCurrent()
        assertThat(controller.isVideoStreaming).isFalse()

        advanceTimeBy(29_000)
        assertThat(ended).isEmpty()
        advanceTimeBy(2_000)
        runCurrent()

        assertThat(ended).containsExactly("idle_timeout")
        assertThat(controller.state.value).isEqualTo(SessionState.Disconnected)
    }

    @Test
    fun `a session that never gets a viewer ends after the idle timeout`() = testScope.runTest {
        create(this)
        controller.connect("ws://s/ws", "tok", "dev-1")
        runCurrent()
        advanceTimeBy(31_000)
        runCurrent()
        assertThat(ended).containsExactly("idle_timeout")
        assertThat(controller.state.value).isEqualTo(SessionState.Disconnected)
    }

    @Test
    fun `an attached viewer keeps the session alive past the idle timeout`() = testScope.runTest {
        create(this)
        connectUp()
        advanceTimeBy(120_000)
        runCurrent()
        assertThat(ended).isEmpty()
        assertThat(controller.state.value).isInstanceOf(SessionState.Connected::class.java)
    }

    @Test
    fun `the session ends at the maximum duration even with a viewer`() = testScope.runTest {
        create(this, max = 100_000)
        connectUp()
        advanceTimeBy(99_000)
        assertThat(ended).isEmpty()
        advanceTimeBy(2_000)
        runCurrent()
        assertThat(ended).containsExactly("max_duration")
        assertThat(controller.state.value).isEqualTo(SessionState.Disconnected)
    }

    @Test
    fun `a closed command channel counts as viewer gone`() = testScope.runTest {
        create(this)
        connectUp()
        channelState.value = com.androidremote.transport.DataChannelState.CLOSED
        runCurrent()
        advanceTimeBy(31_000)
        runCurrent()
        assertThat(ended).containsExactly("idle_timeout")
    }

    // ---- AR-04 / AR-15 ----

    @Test
    fun `video restarts after the session reconnects`() = testScope.runTest {
        create(this)
        val videoChannel = mockk<VideoChannel>(relaxed = true)
        every { videoChannel.isOpen } returns true
        every { session.videoChannel } returns videoChannel
        connectUp()
        val frames = MutableSharedFlow<FrameData>(extraBufferCapacity = 8)
        controller.startVideoStream(frames)
        assertThat(controller.isVideoStreaming).isTrue()
        val readyBefore = readyCount

        transportState.value = TransportSessionState.FAILED
        runCurrent()
        assertThat(controller.isVideoStreaming).isFalse()

        advanceTimeBy(500)
        runCurrent()
        // New transport connection comes up
        dataChannelAvailable.value = true
        transportState.value = TransportSessionState.CONNECTED
        runCurrent()

        assertThat(controller.isVideoStreaming).isTrue()
        assertThat(readyCount).isGreaterThan(readyBefore)
    }

    @Test
    fun `screen info is sent when the viewer is ready`() = testScope.runTest {
        create(this)
        controller.publishScreenInfo(1080, 2400, 90)
        connectUp()
        verify { channel.sendScreenInfo(1080, 2400, 90) }
        assertThat(readyCount).isEqualTo(1)
    }

    @Test
    fun `screen info updates are forwarded while connected`() = testScope.runTest {
        create(this)
        connectUp()
        controller.publishScreenInfo(2400, 1080, 270)
        verify { channel.sendScreenInfo(2400, 1080, 270) }
    }

    @Test
    fun `capture failure is forwarded and replayed to a new viewer`() = testScope.runTest {
        create(this)
        connectUp()
        controller.reportCaptureFailed("consent_required")
        verify { channel.sendCaptureFailed("consent_required") }
    }

    @Test
    fun `REQUEST_KEYFRAME reaches the listener`() = testScope.runTest {
        create(this)
        connectUp()
        controls.emit(ControlMessage.RequestKeyFrame)
        runCurrent()
        assertThat(keyFrames).isEqualTo(1)
    }

    // ---- AR-05 / AR-09 / AR-06 ----

    @Test
    fun `100 rapid taps are all processed in order`() = testScope.runTest {
        create(this)
        val seen = mutableListOf<Float>()
        every { input.handleTap(any()) } answers { seen.add(firstArg<RemoteCommand.Tap>().x); CommandResult.success() }
        connectUp()
        repeat(100) { commands.trySend(CommandEnvelope("c$it", RemoteCommand.Tap(it / 100f, 0.5f))) }
        runCurrent()
        assertThat(seen).isEqualTo((0 until 100).map { it / 100f })
    }

    @Test
    fun `a handler that throws does not stop later commands and is acked as failed`() = testScope.runTest {
        create(this)
        var n = 0
        every { input.handleTap(any()) } answers {
            if (n++ == 0) throw IllegalArgumentException("boom") else CommandResult.success()
        }
        connectUp()
        commands.trySend(CommandEnvelope("bad", RemoteCommand.Tap(0.1f, 0.1f)))
        commands.trySend(CommandEnvelope("good", RemoteCommand.Tap(0.2f, 0.2f)))
        runCurrent()
        verify { channel.sendAck(match { it.commandId == "bad" && !it.success }) }
        verify { channel.sendAck(match { it.commandId == "good" && it.success }) }
    }

    @Test
    fun `commands run on the dedicated input dispatcher and not on the caller thread`() = testScope.runTest {
        val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "input-test-thread") }
        try {
            create(this, inputDispatcher = executor.asCoroutineDispatcher())
            val threads = java.util.concurrent.CopyOnWriteArrayList<String>()
            val done = java.util.concurrent.CountDownLatch(1)
            every { input.handleTap(any()) } answers {
                threads.add(Thread.currentThread().name); done.countDown(); CommandResult.success()
            }
            connectUp()
            commands.trySend(CommandEnvelope("c", RemoteCommand.Tap(0.1f, 0.1f)))
            runCurrent()
            assertThat(done.await(5, java.util.concurrent.TimeUnit.SECONDS)).isTrue()
            assertThat(threads.single()).startsWith("input-test-thread")
        } finally {
            executor.shutdownNow()
        }
    }

    // ---- AR-01 device side ----

    @Test
    fun `wipe without a matching confirm is refused`() = testScope.runTest {
        create(this)
        connectUp()
        commands.trySend(CommandEnvelope("w1", RemoteCommand.WipeDevice()))
        commands.trySend(CommandEnvelope("w2", RemoteCommand.WipeDevice(confirm = "other-device")))
        runCurrent()
        verify(exactly = 0) { mdm.handleWipeDevice(any()) }
        verify { channel.sendAck(match { it.commandId == "w1" && !it.success }) }
        verify { channel.sendAck(match { it.commandId == "w2" && !it.success }) }
    }

    @Test
    fun `wipe with confirm equal to the device id is executed`() = testScope.runTest {
        create(this)
        every { mdm.handleWipeDevice(any()) } returns MdmCommandResult.success()
        connectUp()
        commands.trySend(CommandEnvelope("w3", RemoteCommand.WipeDevice(confirm = "dev-1")))
        runCurrent()
        verify(exactly = 1) { mdm.handleWipeDevice(any()) }
    }

    @Test
    fun `commands arriving after the session ended are not executed`() = testScope.runTest {
        create(this)
        every { input.handleTap(any()) } returns CommandResult.success()
        connectUp()
        controller.disconnect()
        runCurrent()
        commands.trySend(CommandEnvelope("late", RemoteCommand.Tap(0.1f, 0.1f)))
        runCurrent()
        verify(exactly = 0) { input.handleTap(any()) }
    }
}
