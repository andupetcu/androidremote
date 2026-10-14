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
import com.androidremote.transport.ControlMessage
import com.androidremote.transport.DataChannelState
import kotlinx.coroutines.CoroutineDispatcher
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
 * Callbacks from the session to the service that owns capture. All have empty defaults.
 */
interface SessionListener {
    /** A viewer's command channel is up (also after a reconnect): resend keyframe, screen info is already sent. */
    fun onViewerReady() {}

    /** The browser sent REQUEST_KEYFRAME (contract C9). */
    fun onKeyFrameRequested() {}

    /** The controller ended the session by itself ("idle_timeout" or "max_duration"). */
    fun onSessionEnded(reason: String) {}
}

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
    private val initialReconnectDelayMs: Long = 1000,
    /** No viewer for this long ends the session (AR-03). */
    private val idleTimeoutMs: Long = DEFAULT_IDLE_TIMEOUT_MS,
    /** Hard cap on one session (AR-03). */
    private val maxSessionMs: Long = DEFAULT_MAX_SESSION_MS,
    /**
     * Dispatcher for input and MDM command execution (AR-06). Null runs them on the scope's
     * dispatcher. The service passes a dedicated single-thread dispatcher so blocking shell
     * calls never touch Main or the video pipeline.
     */
    private val inputDispatcher: CoroutineDispatcher? = null
) {
    companion object {
        /**
         * Timeout for waiting for the data channel to become available.
         * The data channel arrives via a separate callback after the connection is established.
         */
        private const val DATA_CHANNEL_TIMEOUT_MS = 10_000L
        const val DEFAULT_IDLE_TIMEOUT_MS = 30_000L
        const val DEFAULT_MAX_SESSION_MS = 4 * 60 * 60 * 1000L
    }

    /** Set by the service that owns capture. */
    @Volatile var listener: SessionListener? = null

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
    private var videoFrames: SharedFlow<FrameData>? = null
    private var idleJob: Job? = null
    private var maxDurationJob: Job? = null
    private var peerEventsJob: Job? = null
    private var channelStateJob: Job? = null
    private var controlJob: Job? = null
    private var currentCommandChannel: DeviceCommandChannel? = null
    private var viewerPresent = false
    private var lastScreenInfo: Triple<Int, Int, Int>? = null
    private var lastCaptureFailure: String? = null

    /**
     * True if video streaming is active.
     */
    val isVideoStreaming: Boolean
        get() = videoStreamBridge?.isRunning == true

    /**
     * Connect to a remote session.
     *
     * If already connecting or connected, disconnects the existing session first.
     * This supports server-initiated START_REMOTE commands that may arrive while
     * a previous session is still active.
     *
     * @param serverUrl The signaling server URL
     * @param token Authentication token
     * @param deviceId Device identifier for this session
     */
    fun connect(serverUrl: String, token: String, deviceId: String) {
        if (!_state.value.canConnect) {
            Log.i(TAG, "connect() called while in state ${_state.value}, disconnecting first")
            disconnect()
        }

        currentServerUrl = serverUrl
        currentToken = token
        currentDeviceId = deviceId
        reconnectAttempt = 0

        maxDurationJob?.cancel()
        maxDurationJob = scope.launch {
            delay(maxSessionMs)
            Log.w(TAG, "Maximum session duration reached, ending session")
            endSession("max_duration")
        }

        performConnect()
    }

    /**
     * Tell the viewer the capture geometry (contract C9). Cached and resent to a viewer that attaches later.
     */
    fun publishScreenInfo(width: Int, height: Int, rotation: Int) {
        lastScreenInfo = Triple(width, height, rotation)
        lastCaptureFailure = null
        currentCommandChannel?.takeIf { viewerPresent }?.sendScreenInfo(width, height, rotation)
    }

    /**
     * Tell the viewer why capture cannot start (contract C8). Cached and resent to a viewer that attaches later.
     */
    fun reportCaptureFailed(reason: String) {
        lastCaptureFailure = reason
        currentCommandChannel?.takeIf { viewerPresent }?.sendCaptureFailed(reason)
    }

    /** End the session on our own initiative: notify the owner of capture, then disconnect. */
    private fun endSession(reason: String) {
        try {
            listener?.onSessionEnded(reason)
        } catch (e: Exception) {
            Log.w(TAG, "Listener failed in onSessionEnded", e)
        }
        disconnect()
    }

    private fun armIdleTimer() {
        idleJob?.cancel()
        idleJob = scope.launch {
            delay(idleTimeoutMs)
            Log.i(TAG, "No viewer for ${idleTimeoutMs}ms, ending session")
            endSession("idle_timeout")
        }
    }

    private fun cancelIdleTimer() {
        idleJob?.cancel()
        idleJob = null
    }

    /**
     * The viewer is gone (peer-left or the command channel closed). Stop sending video, wait
     * [idleTimeoutMs] for someone to come back, then end the session. Idempotent per viewer.
     */
    private fun onViewerGone() {
        if (!viewerPresent) return
        viewerPresent = false
        Log.i(TAG, "Viewer left")
        stopVideoStream()
        commandProcessingJob?.cancel()
        channelStateJob?.cancel()
        controlJob?.cancel()
        currentCommandChannel = null
        armIdleTimer()
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
        videoFrames = null
        viewerPresent = false
        currentCommandChannel = null

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
        idleJob?.cancel()
        idleJob = null
        maxDurationJob?.cancel()
        maxDurationJob = null
        peerEventsJob?.cancel()
        peerEventsJob = null
        channelStateJob?.cancel()
        channelStateJob = null
        controlJob?.cancel()
        controlJob = null
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
        currentCommandChannel = commandChannel
        val dispatcher = inputDispatcher
        commandProcessingJob = scope.launch {
            val body: suspend () -> Unit = {
                commandChannel.commands.collect { envelope ->
                    // A bad command must not end the collector (AR-09).
                    try {
                        if (_state.value.isConnected) {
                            processCommand(envelope, commandChannel)
                        } else {
                            Log.w(TAG, "Ignoring command ${envelope.id}: no active session")
                        }
                    } catch (e: kotlinx.coroutines.CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        Log.e(TAG, "Command ${envelope.id} crashed: ${e::class.simpleName}")
                        runCatching {
                            commandChannel.sendAck(CommandAck(envelope.id, false, "Internal error: ${e::class.simpleName}"))
                        }
                    }
                }
            }
            if (dispatcher != null) kotlinx.coroutines.withContext(dispatcher) { body() } else body()
        }

        controlJob?.cancel()
        controlJob = scope.launch {
            try {
                commandChannel.controlMessages.collect { message ->
                    try {
                        when (message) {
                            ControlMessage.RequestKeyFrame -> listener?.onKeyFrameRequested()
                        }
                    } catch (e: kotlinx.coroutines.CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        Log.w(TAG, "Control message handler failed: ${e::class.simpleName}")
                    }
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "Control channel collector ended: ${e::class.simpleName}")
            }
        }

        channelStateJob?.cancel()
        channelStateJob = scope.launch {
            try {
                commandChannel.state.collect { st ->
                    if (st == DataChannelState.CLOSED || st == DataChannelState.CLOSING) onViewerGone()
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "Channel state collector ended: ${e::class.simpleName}")
            }
        }

        // A viewer is attached: stop the idle timer and tell it the current geometry (C9).
        viewerPresent = true
        cancelIdleTimer()
        lastScreenInfo?.let { (w, h, r) -> commandChannel.sendScreenInfo(w, h, r) }
        lastCaptureFailure?.let { commandChannel.sendCaptureFailed(it) }
    }

    private fun notifyViewerReady() {
        try {
            listener?.onViewerReady()
        } catch (e: Exception) {
            Log.w(TAG, "Listener failed in onViewerReady", e)
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

        videoFrames = framesFlow
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

        // Nobody is watching until a viewer's offer arrives (AR-03).
        armIdleTimer()

        connectJob?.cancel()
        connectJob = scope.launch {
            try {
                val serverUrl = currentServerUrl ?: throw IllegalStateException("Server URL not set")
                val deviceId = currentDeviceId ?: throw IllegalStateException("Device ID not set")

                // CRITICAL: Disconnect old session BEFORE creating a new one.
                // The session factory disposes the PeerConnectionFactory, which will SIGSEGV
                // if any PeerConnection from that factory is still alive.
                val oldSession = currentSession
                // Its closing must not look like a fresh connection loss.
                sessionStateJob?.cancel()
                sessionStateJob = null
                peerEventsJob?.cancel()
                peerEventsJob = null
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

                peerEventsJob?.cancel()
                peerEventsJob = launch {
                    try {
                        session.peerLeft.collect { handlePeerLeft() }
                    } catch (e: kotlinx.coroutines.CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        Log.w(TAG, "peerLeft collector ended: ${e::class.simpleName}")
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
                                restartVideoIfNeeded()
                                notifyViewerReady()
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

    /** After a reconnect the old bridge points at a dead channel: rebuild it on the new one (AR-04). */
    private suspend fun restartVideoIfNeeded() {
        val frames = videoFrames ?: return
        try {
            startVideoStream(frames)
            Log.i(TAG, "Video stream restarted on the new connection")
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "Could not restart video: ${e.message}")
        }
    }

    /**
     * The viewer left the room. This session's peer connection belongs to that viewer, so tear
     * it down and wait for a fresh offer on a new one; the idle timer ends the session if nobody comes.
     */
    private fun handlePeerLeft() {
        if (!wasConnected && !viewerPresent) return
        onViewerGone()
        wasConnected = false
        reconnectJob?.cancel()
        performConnect()
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
        Log.d(TAG, "Processing command: ${envelope.command::class.simpleName} (id=${envelope.id})")
        val (success, errorMessage, data) = routeCommand(envelope.command)

        if (!success) {
            Log.w(TAG, "Command ${envelope.command::class.simpleName} failed: $errorMessage")
        }

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
            is RemoteCommand.MultiTap -> inputHandler.handleMultiTap(command).toRouteResult()
            is RemoteCommand.KeyPress -> inputHandler.handleKeyPress(command).toRouteResult()
            is RemoteCommand.TypeText -> textInputHandler.handleTypeText(command).toRouteResult()

            // MDM commands
            is RemoteCommand.GetDeviceInfo -> handleMdmCommand { it.handleGetDeviceInfo() }
            is RemoteCommand.LockDevice -> handleMdmCommand { it.handleLockDevice() }
            is RemoteCommand.RebootDevice -> handleMdmCommand { it.handleRebootDevice() }
            is RemoteCommand.WipeDevice ->
                if (command.confirm.isNullOrEmpty() || command.confirm != currentDeviceId) {
                    RouteResult(false, "WIPE requires confirm equal to the device ID", null)
                } else {
                    handleMdmCommand { it.handleWipeDevice(command) }
                }
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
