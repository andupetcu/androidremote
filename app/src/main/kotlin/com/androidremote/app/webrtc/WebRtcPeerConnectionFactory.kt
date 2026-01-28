package com.androidremote.app.webrtc

import com.androidremote.transport.IceServer
import com.androidremote.transport.NativePeerConnection
import com.androidremote.transport.PeerConnectionConfig
import com.androidremote.transport.PeerConnectionFactoryInterface
import com.androidremote.transport.PeerConnectionObserver
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory

/**
 * Android implementation of PeerConnectionFactoryInterface using org.webrtc.PeerConnectionFactory.
 *
 * Handles WebRTC initialization and peer connection creation.
 */
class WebRtcPeerConnectionFactory(
    private val eglBase: EglBase? = null
) : PeerConnectionFactoryInterface {

    private val factory: PeerConnectionFactory

    init {
        // NOTE: PeerConnectionFactory.initialize() is called once in AndroidRemoteApplication
        // Do NOT call it here - calling it multiple times corrupts native state and causes SIGSEGV

        // Build factory with appropriate options
        val options = PeerConnectionFactory.Options()

        val factoryBuilder = PeerConnectionFactory.builder()
            .setOptions(options)

        // Configure video encoding/decoding if EGL context is provided
        if (eglBase != null) {
            val eglContext = eglBase.eglBaseContext
            factoryBuilder
                .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglContext, true, true))
                .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglContext))
        }

        factory = factoryBuilder.createPeerConnectionFactory()
    }

    override fun createPeerConnection(
        config: PeerConnectionConfig,
        observer: PeerConnectionObserver
    ): NativePeerConnection {
        val rtcConfig = PeerConnection.RTCConfiguration(mapIceServers(config.iceServers)).apply {
            // Enable unified plan for modern WebRTC
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN

            // Disable ICE candidate pooling - can cause issues on some devices
            iceCandidatePoolSize = 0

            // Use all available network interfaces
            candidateNetworkPolicy = PeerConnection.CandidateNetworkPolicy.ALL

            // Simplify ICE transport policy - use all (host, srflx, relay)
            iceTransportsType = PeerConnection.IceTransportsType.ALL
        }

        // Create our wrapper that implements PeerConnection.Observer
        val wrapper = WebRtcPeerConnectionWrapper(observer)

        // Create the native peer connection with our wrapper as the observer
        val nativeConnection = factory.createPeerConnection(rtcConfig, wrapper)
            ?: throw WebRtcException("Failed to create PeerConnection")

        // Initialize the wrapper with the native connection and return it
        wrapper.initialize(nativeConnection)
        return wrapper
    }

    /**
     * Maps our IceServer list to WebRTC PeerConnection.IceServer list.
     */
    private fun mapIceServers(servers: List<IceServer>): List<PeerConnection.IceServer> {
        return servers.map { server ->
            val builder = PeerConnection.IceServer.builder(server.urls)
            server.username?.let { builder.setUsername(it) }
            server.credential?.let { builder.setPassword(it) }
            builder.createIceServer()
        }
    }

    /**
     * Releases resources held by the factory.
     * Call this when the factory is no longer needed.
     */
    fun dispose() {
        factory.dispose()
    }

    companion object {
        /**
         * Creates a factory with minimal configuration (no video encoding/decoding).
         * Suitable for data-channel only connections.
         *
         * NOTE: Requires WebRTC to be initialized via PeerConnectionFactory.initialize()
         * before calling this. This is done in AndroidRemoteApplication.
         */
        fun createDataChannelOnly(): WebRtcPeerConnectionFactory {
            return WebRtcPeerConnectionFactory(eglBase = null)
        }

        /**
         * Creates a factory with video support.
         * Requires an EglBase for hardware video encoding/decoding.
         *
         * NOTE: Requires WebRTC to be initialized via PeerConnectionFactory.initialize()
         * before calling this. This is done in AndroidRemoteApplication.
         */
        fun createWithVideoSupport(eglBase: EglBase): WebRtcPeerConnectionFactory {
            return WebRtcPeerConnectionFactory(eglBase)
        }
    }
}
