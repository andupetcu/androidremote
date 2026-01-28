package com.androidremote.transport

/**
 * WebRTC connection states.
 */
enum class ConnectionState {
    NEW,
    CONNECTING,
    CONNECTED,
    DISCONNECTED,
    FAILED,
    CLOSED
}

/**
 * Configuration for creating a peer connection.
 */
data class PeerConnectionConfig(
    val iceServers: List<IceServer> = emptyList()
)

/**
 * ICE server configuration for STUN/TURN.
 */
data class IceServer(
    val urls: List<String>,
    val username: String? = null,
    val credential: String? = null
)

/**
 * Observer interface for peer connection events.
 */
interface PeerConnectionObserver {
    fun onIceCandidate(candidate: IceCandidate)
    fun onConnectionStateChange(state: ConnectionState)
    fun onIceConnectionStateChange(state: ConnectionState)
    fun onDataChannel(channel: DataChannelInterface)
}

/**
 * Interface for the native peer connection.
 * This abstracts the platform-specific WebRTC implementation.
 */
interface NativePeerConnection {
    suspend fun createOffer(): SessionDescription
    suspend fun createAnswer(): SessionDescription
    suspend fun setLocalDescription(description: SessionDescription)
    suspend fun setRemoteDescription(description: SessionDescription)
    suspend fun addIceCandidate(candidate: IceCandidate)
    fun close()
}

/**
 * Factory interface for creating peer connections.
 * Allows for dependency injection and testing.
 */
interface PeerConnectionFactoryInterface {
    fun createPeerConnection(
        config: PeerConnectionConfig,
        observer: PeerConnectionObserver
    ): NativePeerConnection
}

/**
 * Interface for WebRTC data channels.
 */
interface DataChannelInterface {
    val label: String
    val state: DataChannelState

    fun send(data: ByteArray): Boolean
    fun send(text: String): Boolean
    fun close()

    fun setObserver(observer: DataChannelObserver)
}

/**
 * Data channel states.
 */
enum class DataChannelState {
    CONNECTING,
    OPEN,
    CLOSING,
    CLOSED
}

/**
 * Observer for data channel events.
 */
interface DataChannelObserver {
    fun onStateChange(state: DataChannelState)
    fun onMessage(data: ByteArray)
    fun onMessage(text: String)
}
