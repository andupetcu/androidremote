package com.androidremote.app.controller

import com.androidremote.transport.CommandAck
import com.androidremote.transport.CommandEnvelope
import com.androidremote.transport.DeviceCommandChannel
import com.androidremote.transport.RemoteCommand
import com.androidremote.transport.RemoteSession
import com.androidremote.transport.SessionState as TransportSessionState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Central coordinator for remote control sessions.
 *
 * Owns the RemoteSession (WebRTC), routes commands to appropriate handlers,
 * and manages connection lifecycle including automatic reconnection.
 */
class SessionController(
    private val inputHandler: InputHandler,
    private val textInputHandler: TextInputHandler,
    private val sessionFactory: () -> RemoteSession,
    private val commandChannelFactory: () -> DeviceCommandChannel,
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.Default),
    private val maxReconnectAttempts: Int = 5,
    private val initialReconnectDelayMs: Long = 1000
) {
    private val _state = MutableStateFlow<SessionState>(SessionState.Disconnected)

    /**
     * Current session state.
     */
    val state: StateFlow<SessionState> = _state.asStateFlow()

    private var currentSession: RemoteSession? = null
    private var currentDeviceId: String? = null
    private var currentServerUrl: String? = null
    private var currentToken: String? = null
    private var commandProcessingJob: Job? = null
    private var sessionStateJob: Job? = null
    private var reconnectJob: Job? = null
    private var connectJob: Job? = null
    private var reconnectAttempt: Int = 0
    private var wasConnected: Boolean = false

    /**
     * Connect to a remote session.
     *
     * @param serverUrl The signaling server URL
     * @param token Authentication token
     * @param deviceId Device identifier for this session
     */
    fun connect(serverUrl: String, token: String, deviceId: String) {
        if (!_state.value.canConnect) return

        currentServerUrl = serverUrl
        currentToken = token
        currentDeviceId = deviceId
        reconnectAttempt = 0

        performConnect()
    }

    /**
     * Disconnect from the current session.
     */
    fun disconnect() {
        cancelJobs()

        scope.launch {
            try {
                currentSession?.disconnect()
            } catch (e: Exception) {
                // Ignore disconnect errors
            }
            currentSession = null
            wasConnected = false
            _state.value = SessionState.Disconnected
        }
    }

    /**
     * Cancel all internal jobs. Useful for cleanup in tests.
     */
    fun cancelJobs() {
        commandProcessingJob?.cancel()
        commandProcessingJob = null
        sessionStateJob?.cancel()
        sessionStateJob = null
        reconnectJob?.cancel()
        reconnectJob = null
        connectJob?.cancel()
        connectJob = null
    }

    /**
     * Attempt to reconnect to the session.
     *
     * Uses exponential backoff for retry delays.
     */
    fun reconnect() {
        if (reconnectAttempt >= maxReconnectAttempts) {
            _state.value = SessionState.Error("Max reconnection attempts reached")
            return
        }

        reconnectAttempt++
        _state.value = SessionState.Reconnecting(
            attempt = reconnectAttempt,
            maxAttempts = maxReconnectAttempts
        )

        performConnect()
    }

    /**
     * Start processing commands from the given channel.
     *
     * @param commandChannel The device command channel to receive commands from
     */
    fun startCommandProcessing(commandChannel: DeviceCommandChannel) {
        commandProcessingJob?.cancel()
        commandProcessingJob = scope.launch {
            commandChannel.commands.collect { envelope ->
                processCommand(envelope, commandChannel)
            }
        }
    }

    private fun performConnect() {
        _state.value = SessionState.Connecting

        connectJob?.cancel()
        connectJob = scope.launch {
            try {
                val session = sessionFactory()
                currentSession = session

                // Monitor session state changes
                sessionStateJob?.cancel()
                sessionStateJob = launch {
                    session.state.collect { transportState ->
                        handleTransportStateChange(transportState)
                    }
                }

                session.connect()
                session.startAsAnswerer()

                // Reset reconnect counter on successful connection
                // State will be updated by the session state collector
            } catch (e: Exception) {
                handleConnectionError(e)
            }
        }
    }

    private fun handleTransportStateChange(transportState: TransportSessionState) {
        when (transportState) {
            TransportSessionState.CONNECTED -> {
                wasConnected = true
                reconnectAttempt = 0
                currentDeviceId?.let { deviceId ->
                    _state.value = SessionState.Connected(deviceId)
                }
            }
            TransportSessionState.DISCONNECTED -> {
                if (wasConnected && _state.value.isConnected) {
                    // Unexpected disconnection - start reconnect
                    startReconnectSequence()
                }
            }
            TransportSessionState.FAILED -> {
                if (wasConnected) {
                    startReconnectSequence()
                } else {
                    _state.value = SessionState.Error("Connection failed")
                }
            }
            TransportSessionState.CONNECTING -> {
                // Already in connecting state
            }
        }
    }

    private fun startReconnectSequence() {
        if (reconnectAttempt >= maxReconnectAttempts) {
            _state.value = SessionState.Error("Connection lost after max reconnection attempts")
            return
        }

        reconnectAttempt++
        _state.value = SessionState.Reconnecting(
            attempt = reconnectAttempt,
            maxAttempts = maxReconnectAttempts
        )

        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            // Exponential backoff
            val delayMs = initialReconnectDelayMs * (1 shl (reconnectAttempt - 1))
            delay(delayMs)
            performConnect()
        }
    }

    private fun handleConnectionError(error: Exception) {
        if (reconnectAttempt > 0 && reconnectAttempt < maxReconnectAttempts) {
            // Continue reconnection sequence
            startReconnectSequence()
        } else {
            _state.value = SessionState.Error(error.message ?: "Unknown connection error")
        }
    }

    private fun processCommand(envelope: CommandEnvelope, commandChannel: DeviceCommandChannel) {
        val result = routeCommand(envelope.command)

        val ack = CommandAck(
            commandId = envelope.id,
            success = result.success,
            errorMessage = result.errorMessage
        )

        commandChannel.sendAck(ack)
    }

    private fun routeCommand(command: RemoteCommand): CommandResult {
        return when (command) {
            is RemoteCommand.Tap -> inputHandler.handleTap(command)
            is RemoteCommand.Swipe -> inputHandler.handleSwipe(command)
            is RemoteCommand.LongPress -> inputHandler.handleLongPress(command)
            is RemoteCommand.Pinch -> inputHandler.handlePinch(command)
            is RemoteCommand.Scroll -> inputHandler.handleScroll(command)
            is RemoteCommand.KeyPress -> inputHandler.handleKeyPress(command)
            is RemoteCommand.TypeText -> textInputHandler.handleTypeText(command)
        }
    }
}
