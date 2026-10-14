package com.androidremote.transport

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json

/**
 * Orchestrates a remote control session by coordinating signaling and WebRTC.
 *
 * Handles the full connection lifecycle:
 * 1. Connect to signaling server
 * 2. Create/receive WebRTC offer/answer
 * 3. Exchange ICE candidates
 * 4. Establish data channel for commands
 */
class RemoteSession(
    private val serverUrl: String,
    private val deviceId: String,
    private val webSocketProvider: WebSocketProvider,
    private val peerConnectionFactory: PeerConnectionFactoryInterface,
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.Default),
    /**
     * Whether to auto-create CommandChannel when data channel is established.
     * Set to false on device side where DeviceCommandChannel will be created instead.
     */
    private val createCommandChannel: Boolean = true,
    /**
     * Configuration for the peer connection including ICE servers.
     * Defaults to standard STUN/TURN servers for development.
     */
    private val peerConnectionConfig: PeerConnectionConfig = DEFAULT_CONFIG,
    /**
     * Device session token, sent as `Authorization: Bearer` on the signaling upgrade (contract C4).
     */
    private val authToken: String? = null,
    /**
     * ICE `disconnected` is often transient (Wi-Fi roam). The session only fails if it does not
     * recover within this grace period (AR-04).
     */
    private val iceDisconnectGraceMs: Long = DEFAULT_ICE_DISCONNECT_GRACE_MS
) {
    companion object {
        const val DEFAULT_ICE_DISCONNECT_GRACE_MS = 10_000L

        /**
         * Default ICE servers with STUN only for local network connections.
         * TURN is disabled as it may cause stability issues on some devices.
         */
        val DEFAULT_CONFIG = PeerConnectionConfig(
            iceServers = listOf(
                IceServer(urls = listOf("stun:stun.l.google.com:19302")),
                IceServer(urls = listOf("stun:stun1.l.google.com:19302"))
            )
        )
    }
    private val json = Json { ignoreUnknownKeys = true }

    private var signalingClient: SignalingClient? = null
    private var peerConnection: PeerConnectionWrapper? = null
    private var _commandChannel: CommandChannel? = null
    private var _videoChannel: VideoChannel? = null
    private var _dataChannelInterface: DataChannelInterface? = null
    @Volatile private var videoDataChannel: DataChannelInterface? = null
    private var iceGraceJob: Job? = null

    private val _state = MutableStateFlow(SessionState.DISCONNECTED)
    private val _dataChannelAvailable = MutableStateFlow(false)
    private var messageCollectionJob: Job? = null
    private var iceCandidateJob: Job? = null
    private var remoteIceCandidateJob: Job? = null
    private var connectionStateJob: Job? = null
    private var dataChannelJob: Job? = null

    private val _peerLeft = MutableSharedFlow<Unit>(extraBufferCapacity = 16)
    private val _peerJoined = MutableSharedFlow<String>(extraBufferCapacity = 16)
    private var peerEventsJob: Job? = null

    /** The remote peer (viewer) left the signaling room. */
    val peerLeft: Flow<Unit> = _peerLeft.asSharedFlow()

    /** A peer joined the room; emits its role. */
    val peerJoined: Flow<String> = _peerJoined.asSharedFlow()

    /**
     * Current session state.
     */
    val state: StateFlow<SessionState> = _state.asStateFlow()

    /**
     * Whether the data channel is available for use.
     * Use this to wait for the data channel before creating command channel wrappers.
     */
    val dataChannelAvailable: StateFlow<Boolean> = _dataChannelAvailable.asStateFlow()

    /**
     * Whether the session is connected to the signaling server.
     */
    val isConnected: Boolean
        get() = signalingClient?.isConnected == true

    /**
     * Command channel for sending/receiving commands.
     * Available after WebRTC connection is established.
     */
    val commandChannel: CommandChannel?
        get() = _commandChannel

    /**
     * Raw data channel interface for creating custom channel wrappers.
     * Available after WebRTC connection is established.
     * Use this to create DeviceCommandChannel on the device side.
     */
    val dataChannelInterface: DataChannelInterface?
        get() = _dataChannelInterface

    /**
     * Video channel for sending encoded video frames.
     * Available after WebRTC connection is established.
     */
    val videoChannel: VideoChannel?
        get() = _videoChannel

    /**
     * Connect to the signaling server.
     *
     * @param timeoutMs Connection timeout in milliseconds
     * @throws SessionConnectionException if connection fails or times out
     */
    suspend fun connect(timeoutMs: Long = 30000) {
        try {
            withTimeout(timeoutMs) {
                val client = SignalingClient(
                    serverUrl = serverUrl,
                    deviceId = deviceId,
                    webSocketProvider = webSocketProvider,
                    scope = scope,
                    authToken = authToken
                )
                client.connect()
                signalingClient = client

                peerEventsJob = scope.launch {
                    launch { client.peerLeft.collect { _peerLeft.tryEmit(Unit) } }
                    launch { client.peerJoined.collect { _peerJoined.tryEmit(it) } }
                }

                // Create peer connection with configured ICE servers
                val pc = PeerConnectionWrapper(peerConnectionFactory, peerConnectionConfig)
                peerConnection = pc

                // Set up ICE candidate forwarding
                iceCandidateJob = scope.launch {
                    pc.iceCandidates.collect { candidate ->
                        try {
                            client.sendIceCandidate(candidate)
                        } catch (e: kotlinx.coroutines.CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            System.err.println("RemoteSession: failed to send ICE candidate: ${e.message}")
                        }
                    }
                }

                // Set up connection state tracking
                connectionStateJob = scope.launch {
                    pc.connectionState.collect { connectionState ->
                        when (connectionState) {
                            ConnectionState.CONNECTED -> {
                                iceGraceJob?.cancel()
                                iceGraceJob = null
                                _state.value = SessionState.CONNECTED
                            }
                            ConnectionState.FAILED -> {
                                iceGraceJob?.cancel()
                                iceGraceJob = null
                                _state.value = SessionState.FAILED
                            }
                            ConnectionState.DISCONNECTED -> {
                                // Transient until proven otherwise (AR-04).
                                if (_state.value == SessionState.CONNECTED && iceGraceJob == null) {
                                    iceGraceJob = launch {
                                        delay(iceDisconnectGraceMs)
                                        iceGraceJob = null
                                        _state.value = SessionState.FAILED
                                    }
                                }
                            }
                            else -> {}
                        }
                    }
                }

                // Set up data channel handling
                dataChannelJob = scope.launch {
                    pc.dataChannels.collect { channel ->
                        if (channel.label == "video") {
                            videoDataChannel = channel
                        } else if (channel.label == "commands") {
                            _dataChannelInterface = channel
                            _dataChannelAvailable.value = true
                            // Video prefers the `video` channel and falls back to `commands` (C9)
                            _videoChannel = VideoChannel({ videoDataChannel }, { _dataChannelInterface })
                            // Only create CommandChannel if enabled (web client mode)
                            // Device mode should use dataChannelInterface to create DeviceCommandChannel
                            if (createCommandChannel) {
                                _commandChannel = CommandChannel(channel)
                            }
                        }
                    }
                }
            }
        } catch (e: Exception) {
            _state.value = SessionState.FAILED
            throw SessionConnectionException("Failed to connect", e)
        }
    }

    /**
     * Start the session as the offerer (creates and sends SDP offer).
     */
    suspend fun startAsOfferer() {
        val client = signalingClient ?: throw SessionConnectionException("Not connected")
        val pc = peerConnection ?: throw SessionConnectionException("No peer connection")

        _state.value = SessionState.CONNECTING

        // Create and send offer
        val offer = pc.createOffer()
        pc.setLocalDescription(offer)
        client.sendOffer(offer)

        // Listen for answer
        messageCollectionJob = scope.launch {
            client.answers.collect { answer ->
                guarded("set remote description") { pc.setRemoteDescription(answer) }
            }
        }

        // Listen for remote ICE candidates
        remoteIceCandidateJob = scope.launch {
            client.iceCandidates.collect { candidate ->
                guarded("add ICE candidate") { pc.addIceCandidate(candidate) }
            }
        }
    }

    /**
     * Start the session as the answerer (waits for offer and sends answer).
     */
    suspend fun startAsAnswerer() {
        val client = signalingClient ?: throw SessionConnectionException("Not connected")
        val pc = peerConnection ?: throw SessionConnectionException("No peer connection")

        _state.value = SessionState.CONNECTING

        // Listen for incoming offers and respond with answer
        messageCollectionJob = scope.launch {
            client.offers.collect { offer ->
                guarded("handle offer") { handleOffer(offer) }
            }
        }

        // Listen for remote ICE candidates
        remoteIceCandidateJob = scope.launch {
            client.iceCandidates.collect { candidate ->
                guarded("add ICE candidate") { pc.addIceCandidate(candidate) }
            }
        }
    }

    /** One bad message must not end the collector (AR-09). */
    private suspend fun guarded(what: String, block: suspend () -> Unit) {
        try {
            block()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            System.err.println("RemoteSession: failed to $what: ${e::class.simpleName}")
        }
    }

    /**
     * Handle an incoming offer (for answerer mode).
     */
    suspend fun handleOffer(offer: SessionDescription) {
        val client = signalingClient ?: throw SessionConnectionException("Not connected")
        val pc = peerConnection ?: throw SessionConnectionException("No peer connection")

        pc.setRemoteDescription(offer)
        val answer = pc.createAnswer()
        pc.setLocalDescription(answer)
        client.sendAnswer(answer)
    }

    /**
     * Disconnect and clean up resources.
     */
    suspend fun disconnect() {
        closeSync()
        disconnectSignaling()
    }

    /**
     * Synchronously close the peer connection and cancel all jobs.
     *
     * This MUST be called before PeerConnectionFactory.dispose() to prevent
     * SIGSEGV in native WebRTC code. PeerConnection.close() is synchronous
     * in the native layer, so this is safe to call from any thread.
     */
    fun closeSync() {
        messageCollectionJob?.cancel()
        iceCandidateJob?.cancel()
        remoteIceCandidateJob?.cancel()
        connectionStateJob?.cancel()
        dataChannelJob?.cancel()
        peerEventsJob?.cancel()
        iceGraceJob?.cancel()
        iceGraceJob = null
        videoDataChannel = null

        _commandChannel?.close()
        _commandChannel = null
        _videoChannel = null
        _dataChannelInterface = null
        _dataChannelAvailable.value = false

        peerConnection?.close()
        peerConnection = null

        _state.value = SessionState.DISCONNECTED
    }

    /**
     * Disconnect the signaling WebSocket.
     * Safe to call after closeSync().
     */
    suspend fun disconnectSignaling() {
        signalingClient?.disconnect()
        signalingClient = null
    }
}

/**
 * Session states.
 */
enum class SessionState {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    FAILED
}

/**
 * Exception thrown when session connection fails.
 */
class SessionConnectionException(message: String, cause: Throwable? = null) : Exception(message, cause)
