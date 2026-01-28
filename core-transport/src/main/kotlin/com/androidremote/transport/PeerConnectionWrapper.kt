package com.androidremote.transport

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Wrapper around WebRTC peer connection that provides a coroutine-friendly API.
 *
 * Handles SDP offer/answer exchange, ICE candidate gathering, and connection state management.
 */
class PeerConnectionWrapper(
    private val factory: PeerConnectionFactoryInterface,
    config: PeerConnectionConfig = PeerConnectionConfig()
) : PeerConnectionObserver {

    private val _connectionState = MutableStateFlow(ConnectionState.NEW)
    private val _iceCandidates = MutableSharedFlow<IceCandidate>(replay = 1)
    private val _dataChannels = MutableSharedFlow<DataChannelInterface>(replay = 1)

    /**
     * Current connection state.
     */
    val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

    /**
     * Flow of ICE candidates gathered during connection establishment.
     */
    val iceCandidates: Flow<IceCandidate> = _iceCandidates.asSharedFlow()

    /**
     * Flow of data channels created by the remote peer.
     */
    val dataChannels: Flow<DataChannelInterface> = _dataChannels.asSharedFlow()

    private val nativeConnection: NativePeerConnection = factory.createPeerConnection(config, this)

    /**
     * Create an SDP offer for initiating a connection.
     */
    suspend fun createOffer(): SessionDescription {
        return nativeConnection.createOffer()
    }

    /**
     * Create an SDP answer in response to a remote offer.
     */
    suspend fun createAnswer(): SessionDescription {
        return nativeConnection.createAnswer()
    }

    /**
     * Set the local session description (our offer or answer).
     */
    suspend fun setLocalDescription(description: SessionDescription) {
        nativeConnection.setLocalDescription(description)
    }

    /**
     * Set the remote session description (peer's offer or answer).
     */
    suspend fun setRemoteDescription(description: SessionDescription) {
        nativeConnection.setRemoteDescription(description)
    }

    /**
     * Add an ICE candidate received from the remote peer via signaling.
     */
    suspend fun addIceCandidate(candidate: IceCandidate) {
        nativeConnection.addIceCandidate(candidate)
    }

    /**
     * Close the peer connection and release resources.
     */
    fun close() {
        nativeConnection.close()
        _connectionState.value = ConnectionState.CLOSED
    }

    // PeerConnectionObserver implementation

    override fun onIceCandidate(candidate: IceCandidate) {
        _iceCandidates.tryEmit(candidate)
    }

    override fun onConnectionStateChange(state: ConnectionState) {
        _connectionState.value = state
    }

    override fun onIceConnectionStateChange(state: ConnectionState) {
        // Map ICE connection state to general connection state
        when (state) {
            ConnectionState.CONNECTED -> _connectionState.value = ConnectionState.CONNECTED
            ConnectionState.DISCONNECTED -> _connectionState.value = ConnectionState.DISCONNECTED
            ConnectionState.FAILED -> _connectionState.value = ConnectionState.FAILED
            else -> { /* Don't update for intermediate states */ }
        }
    }

    override fun onDataChannel(channel: DataChannelInterface) {
        _dataChannels.tryEmit(channel)
    }
}
