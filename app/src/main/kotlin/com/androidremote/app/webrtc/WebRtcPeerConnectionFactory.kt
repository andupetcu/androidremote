package com.androidremote.app.webrtc

import android.content.Context
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
    context: Context,
    private val eglBase: EglBase? = null
) : PeerConnectionFactoryInterface {

    private val factory: PeerConnectionFactory

    init {
        // Initialize WebRTC
        val initOptions = PeerConnectionFactory.InitializationOptions.builder(context.applicationContext)
            .setEnableInternalTracer(false)
            .createInitializationOptions()
        PeerConnectionFactory.initialize(initOptions)

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

            // Configure ICE candidate pool for faster connection
            iceCandidatePoolSize = 2

            // Use all available network interfaces
            candidateNetworkPolicy = PeerConnection.CandidateNetworkPolicy.ALL
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
         */
        fun createDataChannelOnly(context: Context): WebRtcPeerConnectionFactory {
            return WebRtcPeerConnectionFactory(context, eglBase = null)
        }

        /**
         * Creates a factory with video support.
         * Requires an EglBase for hardware video encoding/decoding.
         */
        fun createWithVideoSupport(context: Context, eglBase: EglBase): WebRtcPeerConnectionFactory {
            return WebRtcPeerConnectionFactory(context, eglBase)
        }
    }
}
