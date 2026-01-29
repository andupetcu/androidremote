package com.androidremote.transport

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * WebSocket client for WebRTC signaling.
 *
 * Handles the exchange of SDP offers/answers and ICE candidates
 * between the Android device and web controller via the server.
 */
class SignalingClient(
    private val serverUrl: String,
    private val deviceId: String,
    private val webSocketProvider: WebSocketProvider,
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.Default)
) {
    private val json = Json { ignoreUnknownKeys = true }

    private var session: WebSocketSession? = null
    private var messageJob: Job? = null

    private val _offers = MutableSharedFlow<SessionDescription>(replay = 1)
    private val _answers = MutableSharedFlow<SessionDescription>(replay = 1)
    private val _iceCandidates = MutableSharedFlow<IceCandidate>(replay = 1)
    private val _peerJoined = MutableSharedFlow<String>(replay = 1)
    private val _peerLeft = MutableSharedFlow<Unit>(replay = 1)
    private val _errors = MutableSharedFlow<String>(replay = 1)

    /**
     * Flow of received SDP offers from the remote peer (for answerer mode).
     */
    val offers: Flow<SessionDescription> = _offers.asSharedFlow()

    /**
     * Flow of received SDP answers from the remote peer.
     */
    val answers: Flow<SessionDescription> = _answers.asSharedFlow()

    /**
     * Flow of received ICE candidates from the remote peer.
     */
    val iceCandidates: Flow<IceCandidate> = _iceCandidates.asSharedFlow()

    /**
     * Flow of peer-joined events (emits the role of the joined peer).
     */
    val peerJoined: Flow<String> = _peerJoined.asSharedFlow()

    /**
     * Flow of peer-left events.
     */
    val peerLeft: Flow<Unit> = _peerLeft.asSharedFlow()

    /**
     * Flow of error messages from the server.
     */
    val errors: Flow<String> = _errors.asSharedFlow()

    /**
     * Whether the client is currently connected to the signaling server.
     */
    val isConnected: Boolean
        get() = session?.isConnected == true

    /**
     * Connect to the signaling server and join the room as a device.
     *
     * @throws SignalingConnectionException if connection fails
     */
    suspend fun connect() {
        try {
            session = webSocketProvider.connect(serverUrl, emptyMap())

            // Start listening for incoming messages
            messageJob = scope.launch {
                try {
                    session?.incoming?.collect { message ->
                        handleIncomingMessage(message)
                    }
                    // Flow completed normally = connection closed
                    _errors.emit("Signaling connection closed")
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (e: Exception) {
                    _errors.emit("Signaling connection lost: ${e.message}")
                }
            }

            // Join the room as the device
            join()
        } catch (e: Exception) {
            throw SignalingConnectionException("Failed to connect to signaling server", e)
        }
    }

    /**
     * Join the signaling room as a device.
     */
    private suspend fun join() {
        val message = SignalingMessage.Join(deviceId = deviceId, role = "device")
        sendMessage(message)
    }

    /**
     * Disconnect from the signaling server.
     */
    suspend fun disconnect() {
        messageJob?.cancel()
        messageJob = null
        session?.close()
        session = null
    }

    /**
     * Send an SDP offer to the remote peer.
     */
    suspend fun sendOffer(offer: SessionDescription) {
        val message = SignalingMessage.Offer(sdp = offer.sdp)
        sendMessage(message)
    }

    /**
     * Send an SDP answer to the remote peer.
     */
    suspend fun sendAnswer(answer: SessionDescription) {
        val message = SignalingMessage.Answer(sdp = answer.sdp)
        sendMessage(message)
    }

    /**
     * Send an ICE candidate to the remote peer.
     */
    suspend fun sendIceCandidate(candidate: IceCandidate) {
        val message = SignalingMessage.Ice(candidate)
        sendMessage(message)
    }

    private suspend fun sendMessage(message: SignalingMessage) {
        val jsonString = json.encodeToString(message)
        session?.send(jsonString) ?: throw SignalingConnectionException("Not connected")
    }

    private suspend fun handleIncomingMessage(messageText: String) {
        try {
            val message = json.decodeFromString<SignalingMessage>(messageText)
            when (message) {
                is SignalingMessage.Join -> {
                    // We don't expect to receive join messages as a device
                }
                is SignalingMessage.Offer -> {
                    _offers.emit(SessionDescription(type = "offer", sdp = message.sdp))
                }
                is SignalingMessage.Answer -> {
                    _answers.emit(SessionDescription(type = "answer", sdp = message.sdp))
                }
                is SignalingMessage.Ice -> {
                    _iceCandidates.emit(message.candidate)
                }
                is SignalingMessage.PeerJoined -> {
                    _peerJoined.emit(message.role)
                }
                is SignalingMessage.PeerLeft -> {
                    _peerLeft.emit(Unit)
                }
                is SignalingMessage.Error -> {
                    _errors.emit(message.message)
                }
            }
        } catch (e: Exception) {
            // Log parsing error but don't crash
        }
    }
}
