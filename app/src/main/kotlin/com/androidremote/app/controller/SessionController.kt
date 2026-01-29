package com.androidremote.app.controller

import android.util.Log
import com.androidremote.transport.CommandAck
import com.androidremote.transport.CommandEnvelope
import com.androidremote.transport.CommandResponseData
import com.androidremote.transport.DeviceCommandChannel
import com.androidremote.transport.FrameData
import com.androidremote.transport.RemoteCommand
import com.androidremote.transport.RemoteSession
import com.androidremote.transport.SessionState as TransportSessionState
import com.androidremote.transport.VideoStreamBridge
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

private const val TAG = "SessionController"

/**
 * Central coordinator for remote control sessions.
 *
 * Owns the RemoteSession (WebRTC), routes commands to appropriate handlers,
 * and manages connection lifecycle including automatic reconnection.
 */
class SessionController(
    private val inputHandler: InputHandler,
    private val textInputHandler: TextInputHandler,
    private val mdmHandler: MdmHandler? = null,
    private val sessionFactory: (serverUrl: String, deviceId: String) -> RemoteSession,
    private val commandChannelFactory: (session: RemoteSession) -> DeviceCommandChannel,
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.Default),
    private val maxReconnectAttempts: Int = 5,
    private val initialReconnectDelayMs: Long = 1000
) {
    companion object {
        /**
         * Timeout for waiting for the data channel to become available.
         * The data channel arrives via a separate callback after the connection is established.
         */
        private const val DATA_CHANNEL_TIMEOUT_MS = 10_000L
    }
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
    private var videoStreamBridge: VideoStreamBridge? = null

    /**
     * True if video streaming is active.
     */
    val isVideoStreaming: Boolean
        get() = videoStreamBridge?.isRunning == true

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
     *
     * Closes the peer connection synchronously to ensure native WebRTC resources
     * are released before PeerConnectionFactory.dispose() is called.
     * The signaling WebSocket is closed asynchronously since it doesn't hold
     * native resources that could cause SIGSEGV.
     */
    fun disconnect() {
        cancelJobs()
        stopVideoStream()

        val session = currentSession
        currentSession = null
        wasConnected = false
        _state.value = SessionState.Disconnected

        if (session != null) {
            // Close peer connection synchronously — this is critical to avoid
            // SIGSEGV when PeerConnectionFactory.dispose() is called afterward.
            // PeerConnection.close() is synchronous in the WebRTC native layer.
            session.closeSync()

            // Clean up signaling WebSocket asynchronously
            scope.launch {
                try {
                    session.disconnectSignaling()
                } catch (e: Exception) {
                    Log.w(TAG, "Error disconnecting signaling", e)
                }
            }
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

    /**
     * Start streaming video frames over the session.
     *
     * This suspends until the video channel becomes available (up to timeout).
     *
     * @param framesFlow Flow of encoded frames to transmit
     * @throws IllegalStateException if video channel is not available after timeout
     */
    suspend fun startVideoStream(framesFlow: SharedFlow<FrameData>) {
        val session = currentSession
            ?: throw IllegalStateException("No active session")

        // Wait for the data channel (and video channel) to be available
        val channelReady = withTimeoutOrNull(DATA_CHANNEL_TIMEOUT_MS) {
            session.dataChannelAvailable.first { it }
        }

        if (channelReady != true) {
            throw IllegalStateException("Video channel not available after timeout")
        }

        val videoChannel = session.videoChannel
            ?: throw IllegalStateException("Video channel not available")

        stopVideoStream()

        videoStreamBridge = VideoStreamBridge(videoChannel, framesFlow, scope).apply {
            start()
        }
    }

    /**
     * Stop streaming video frames.
     */
    fun stopVideoStream() {
        videoStreamBridge?.stop()
        videoStreamBridge = null
    }

    private fun performConnect() {
        _state.value = SessionState.Connecting

        connectJob?.cancel()
        connectJob = scope.launch {
            try {
                val serverUrl = currentServerUrl ?: throw IllegalStateException("Server URL not set")
                val deviceId = currentDeviceId ?: throw IllegalStateException("Device ID not set")

                // CRITICAL: Disconnect old session BEFORE creating a new one.
                // The session factory disposes the PeerConnectionFactory, which will SIGSEGV
                // if any PeerConnection from that factory is still alive.
                val oldSession = currentSession
                if (oldSession != null) {
                    Log.i(TAG, "Disconnecting previous session before reconnect")
                    try {
                        oldSession.disconnect()
                    } catch (e: Exception) {
                        Log.w(TAG, "Error disconnecting old session", e)
                    }
                    currentSession = null
                }

                Log.i(TAG, "Connecting to signaling server: $serverUrl (device: $deviceId)")

                val session = sessionFactory(serverUrl, deviceId)
                currentSession = session

                // Monitor session state changes
                sessionStateJob?.cancel()
                sessionStateJob = launch {
                    session.state.collect { transportState ->
                        handleTransportStateChange(transportState)
                    }
                }

                session.connect()
                Log.i(TAG, "Signaling WebSocket connected, starting as answerer")
                session.startAsAnswerer()
                Log.i(TAG, "Answerer mode started, waiting for offer")

                // Reset reconnect counter on successful connection
                // State will be updated by the session state collector
            } catch (e: Exception) {
                Log.e(TAG, "Connection failed: ${e.message}", e)
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

                // Create command channel and start processing commands
                // Must wait for data channel to be available (comes via separate callback)
                currentSession?.let { session ->
                    scope.launch {
                        // Wait for data channel with timeout
                        val dataChannelReady = withTimeoutOrNull(DATA_CHANNEL_TIMEOUT_MS) {
                            session.dataChannelAvailable.first { it }
                        }

                        if (dataChannelReady == true) {
                            try {
                                val commandChannel = commandChannelFactory(session)
                                startCommandProcessing(commandChannel)
                            } catch (e: Exception) {
                                _state.value = SessionState.Error("Failed to create command channel: ${e.message}")
                            }
                        } else {
                            _state.value = SessionState.Error("Data channel not available after timeout")
                        }
                    }
                }
            }
            TransportSessionState.DISCONNECTED -> {
                // Stop video streaming immediately to prevent crashes on dead channel
                stopVideoStream()

                if (wasConnected && _state.value.isConnected) {
                    // Unexpected disconnection - start reconnect
                    startReconnectSequence()
                }
            }
            TransportSessionState.FAILED -> {
                // Stop video streaming immediately to prevent crashes on dead channel
                stopVideoStream()

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
        val (success, errorMessage, data) = routeCommand(envelope.command)

        val ack = CommandAck(
            commandId = envelope.id,
            success = success,
            errorMessage = errorMessage,
            data = data
        )

        commandChannel.sendAck(ack)
    }

    /**
     * Route result that can include response data for MDM commands.
     */
    private data class RouteResult(
        val success: Boolean,
        val errorMessage: String?,
        val data: CommandResponseData? = null
    )

    private fun routeCommand(command: RemoteCommand): RouteResult {
        return when (command) {
            // Input commands
            is RemoteCommand.Tap -> inputHandler.handleTap(command).toRouteResult()
            is RemoteCommand.Swipe -> inputHandler.handleSwipe(command).toRouteResult()
            is RemoteCommand.LongPress -> inputHandler.handleLongPress(command).toRouteResult()
            is RemoteCommand.Pinch -> inputHandler.handlePinch(command).toRouteResult()
            is RemoteCommand.Scroll -> inputHandler.handleScroll(command).toRouteResult()
            is RemoteCommand.KeyPress -> inputHandler.handleKeyPress(command).toRouteResult()
            is RemoteCommand.TypeText -> textInputHandler.handleTypeText(command).toRouteResult()

            // MDM commands
            is RemoteCommand.GetDeviceInfo -> handleMdmCommand { it.handleGetDeviceInfo() }
            is RemoteCommand.LockDevice -> handleMdmCommand { it.handleLockDevice() }
            is RemoteCommand.RebootDevice -> handleMdmCommand { it.handleRebootDevice() }
            is RemoteCommand.WipeDevice -> handleMdmCommand { it.handleWipeDevice(command) }
            is RemoteCommand.ListApps -> handleMdmCommand { it.handleListApps(command) }
            is RemoteCommand.InstallApp -> handleMdmCommand { it.handleInstallApp(command) }
            is RemoteCommand.UninstallApp -> handleMdmCommand { it.handleUninstallApp(command) }
        }
    }

    private fun handleMdmCommand(action: (MdmHandler) -> MdmCommandResult): RouteResult {
        val handler = mdmHandler
            ?: return RouteResult(false, "MDM handler not available", null)

        val result = action(handler)
        return RouteResult(result.success, result.errorMessage, result.data)
    }

    private fun CommandResult.toRouteResult(): RouteResult {
        return RouteResult(success, errorMessage, null)
    }
}
