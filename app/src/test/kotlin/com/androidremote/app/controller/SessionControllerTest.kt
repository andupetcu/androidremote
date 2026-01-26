package com.androidremote.app.controller

import com.androidremote.transport.CommandEnvelope
import com.androidremote.transport.DeviceCommandChannel
import com.androidremote.transport.RemoteCommand
import com.androidremote.transport.RemoteSession
import com.androidremote.transport.SessionState as TransportSessionState
import com.google.common.truth.Truth.assertThat
import io.mockk.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SessionControllerTest {

    private lateinit var controller: SessionController
    private lateinit var mockSession: RemoteSession
    private lateinit var mockCommandChannel: DeviceCommandChannel
    private lateinit var mockInputHandler: InputHandler
    private lateinit var mockTextInputHandler: TextInputHandler

    private lateinit var commandsFlow: MutableSharedFlow<CommandEnvelope>
    private lateinit var sessionStateFlow: MutableStateFlow<TransportSessionState>

    private val testDispatcher = StandardTestDispatcher()
    private val testScope = TestScope(testDispatcher)

    @BeforeEach
    fun setUp() {
        mockSession = mockk(relaxed = true)
        mockCommandChannel = mockk(relaxed = true)
        mockInputHandler = mockk(relaxed = true)
        mockTextInputHandler = mockk(relaxed = true)

        commandsFlow = MutableSharedFlow(replay = 1)
        sessionStateFlow = MutableStateFlow(TransportSessionState.DISCONNECTED)

        every { mockSession.state } returns sessionStateFlow
        every { mockSession.commandChannel } returns null
        every { mockCommandChannel.commands } returns commandsFlow
        every { mockCommandChannel.isOpen } returns true
    }

    private fun createController(scope: CoroutineScope) = SessionController(
        inputHandler = mockInputHandler,
        textInputHandler = mockTextInputHandler,
        sessionFactory = { _, _ -> mockSession },
        commandChannelFactory = { _ -> mockCommandChannel },
        scope = scope,
        maxReconnectAttempts = 3,
        initialReconnectDelayMs = 100
    )

    @AfterEach
    fun tearDown() {
        if (::controller.isInitialized) {
            controller.cancelJobs()
        }
        clearAllMocks()
    }

    @Test
    fun `initial state is Disconnected`() = testScope.runTest {
        controller = createController(this)
        assertThat(controller.state.value).isEqualTo(SessionState.Disconnected)
    }

    @Test
    fun `connect transitions to Connected on success`() = testScope.runTest {
        controller = createController(this)
        coEvery { mockSession.connect(any()) } just Runs
        coEvery { mockSession.startAsAnswerer() } just Runs

        controller.connect("server-url", "token", "device-123")
        advanceUntilIdle()

        // Simulate connection success
        sessionStateFlow.value = TransportSessionState.CONNECTED
        advanceUntilIdle()

        assertThat(controller.state.value).isInstanceOf(SessionState.Connected::class.java)
        assertThat((controller.state.value as SessionState.Connected).deviceId).isEqualTo("device-123")

        controller.cancelJobs()
    }

    @Test
    fun `connect transitions to Error on failure`() = testScope.runTest {
        controller = createController(this)
        coEvery { mockSession.connect(any()) } throws Exception("Connection failed")

        controller.connect("server-url", "token", "device-123")
        advanceUntilIdle()

        assertThat(controller.state.value).isInstanceOf(SessionState.Error::class.java)
        assertThat((controller.state.value as SessionState.Error).message).contains("Connection failed")

        controller.cancelJobs()
    }

    @Test
    fun `disconnect transitions to Disconnected`() = testScope.runTest {
        controller = createController(this)
        // First connect
        coEvery { mockSession.connect(any()) } just Runs
        coEvery { mockSession.startAsAnswerer() } just Runs
        coEvery { mockSession.disconnect() } just Runs

        controller.connect("server-url", "token", "device-123")
        advanceUntilIdle()
        sessionStateFlow.value = TransportSessionState.CONNECTED
        advanceUntilIdle()

        // Now disconnect
        controller.disconnect()
        advanceUntilIdle()

        assertThat(controller.state.value).isEqualTo(SessionState.Disconnected)
        coVerify { mockSession.disconnect() }
    }

    @Test
    fun `routes tap command to input handler`() = testScope.runTest {
        controller = createController(this)
        // Setup connected state
        coEvery { mockSession.connect(any()) } just Runs
        coEvery { mockSession.startAsAnswerer() } just Runs
        every { mockInputHandler.handleTap(any()) } returns CommandResult.success()

        controller.connect("server-url", "token", "device-123")
        advanceUntilIdle()
        sessionStateFlow.value = TransportSessionState.CONNECTED
        advanceUntilIdle()

        // Start command processing
        controller.startCommandProcessing(mockCommandChannel)
        advanceUntilIdle()

        // Emit a tap command
        val tapCommand = RemoteCommand.Tap(x = 0.5f, y = 0.5f)
        val envelope = CommandEnvelope(id = "cmd-1", command = tapCommand)
        commandsFlow.emit(envelope)
        advanceUntilIdle()

        verify { mockInputHandler.handleTap(tapCommand) }

        controller.cancelJobs()
    }

    @Test
    fun `routes text command to text handler`() = testScope.runTest {
        controller = createController(this)
        // Setup connected state
        coEvery { mockSession.connect(any()) } just Runs
        coEvery { mockSession.startAsAnswerer() } just Runs
        every { mockTextInputHandler.handleTypeText(any()) } returns CommandResult.success()

        controller.connect("server-url", "token", "device-123")
        advanceUntilIdle()
        sessionStateFlow.value = TransportSessionState.CONNECTED
        advanceUntilIdle()

        // Start command processing
        controller.startCommandProcessing(mockCommandChannel)
        advanceUntilIdle()

        // Emit a text command
        val textCommand = RemoteCommand.TypeText(text = "Hello World")
        val envelope = CommandEnvelope(id = "cmd-2", command = textCommand)
        commandsFlow.emit(envelope)
        advanceUntilIdle()

        verify { mockTextInputHandler.handleTypeText(textCommand) }

        controller.cancelJobs()
    }

    @Test
    fun `sends ack after successful command`() = testScope.runTest {
        controller = createController(this)
        // Setup connected state
        coEvery { mockSession.connect(any()) } just Runs
        coEvery { mockSession.startAsAnswerer() } just Runs
        every { mockInputHandler.handleTap(any()) } returns CommandResult.success()
        every { mockCommandChannel.sendAck(any()) } returns true

        controller.connect("server-url", "token", "device-123")
        advanceUntilIdle()
        sessionStateFlow.value = TransportSessionState.CONNECTED
        advanceUntilIdle()

        controller.startCommandProcessing(mockCommandChannel)
        advanceUntilIdle()

        // Emit a tap command
        val tapCommand = RemoteCommand.Tap(x = 0.5f, y = 0.5f)
        val envelope = CommandEnvelope(id = "cmd-3", command = tapCommand)
        commandsFlow.emit(envelope)
        advanceUntilIdle()

        verify {
            mockCommandChannel.sendAck(match {
                it.commandId == "cmd-3" && it.success
            })
        }

        controller.cancelJobs()
    }

    @Test
    fun `sends error ack when handler fails`() = testScope.runTest {
        controller = createController(this)
        // Setup connected state
        coEvery { mockSession.connect(any()) } just Runs
        coEvery { mockSession.startAsAnswerer() } just Runs
        every { mockInputHandler.handleTap(any()) } returns CommandResult.error("Touch injection failed")
        every { mockCommandChannel.sendAck(any()) } returns true

        controller.connect("server-url", "token", "device-123")
        advanceUntilIdle()
        sessionStateFlow.value = TransportSessionState.CONNECTED
        advanceUntilIdle()

        controller.startCommandProcessing(mockCommandChannel)
        advanceUntilIdle()

        // Emit a tap command
        val tapCommand = RemoteCommand.Tap(x = 0.5f, y = 0.5f)
        val envelope = CommandEnvelope(id = "cmd-4", command = tapCommand)
        commandsFlow.emit(envelope)
        advanceUntilIdle()

        verify {
            mockCommandChannel.sendAck(match {
                it.commandId == "cmd-4" && !it.success && it.errorMessage == "Touch injection failed"
            })
        }

        controller.cancelJobs()
    }

    @Test
    fun `starts reconnect on connection lost`() = testScope.runTest {
        controller = createController(this)
        // Setup connected state
        coEvery { mockSession.connect(any()) } just Runs
        coEvery { mockSession.startAsAnswerer() } just Runs

        controller.connect("server-url", "token", "device-123")
        advanceUntilIdle()

        // First establish connection
        sessionStateFlow.value = TransportSessionState.CONNECTED
        advanceUntilIdle()

        assertThat(controller.state.value).isInstanceOf(SessionState.Connected::class.java)

        // Simulate connection lost - only run current tasks, don't advance time
        // so we can observe the Reconnecting state before the delay completes
        sessionStateFlow.value = TransportSessionState.DISCONNECTED
        testScheduler.runCurrent()

        assertThat(controller.state.value).isInstanceOf(SessionState.Reconnecting::class.java)
        val reconnectState = controller.state.value as SessionState.Reconnecting
        assertThat(reconnectState.attempt).isEqualTo(1)
        assertThat(reconnectState.maxAttempts).isEqualTo(3)

        // Cancel jobs before advancing time to avoid running more reconnect attempts
        controller.cancelJobs()
        advanceUntilIdle()
    }

    @Test
    fun `stops reconnect after max attempts`() = testScope.runTest {
        controller = createController(this)
        var connectionAttempts = 0

        // Setup - make all connection attempts fail
        coEvery { mockSession.connect(any()) } answers {
            connectionAttempts++
            throw Exception("Network unavailable")
        }
        coEvery { mockSession.disconnect() } just Runs

        // First connection attempt
        controller.connect("server-url", "token", "device-123")
        advanceUntilIdle()

        // First attempt fails - should be in Error state
        assertThat(controller.state.value).isInstanceOf(SessionState.Error::class.java)

        // Manual reconnect attempts
        repeat(3) {
            controller.reconnect()
            advanceUntilIdle()
        }

        // After max attempts, should be in Error state
        assertThat(controller.state.value).isInstanceOf(SessionState.Error::class.java)
        assertThat((controller.state.value as SessionState.Error).message).contains("Max reconnection attempts")

        controller.cancelJobs()
    }
}
