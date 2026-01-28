package com.androidremote.app.webrtc

import com.androidremote.transport.ConnectionState
import com.androidremote.transport.IceCandidate
import com.androidremote.transport.NativePeerConnection
import com.androidremote.transport.PeerConnectionObserver
import com.androidremote.transport.SessionDescription
import kotlinx.coroutines.suspendCancellableCoroutine
import org.webrtc.AddIceObserver
import org.webrtc.DataChannel
import org.webrtc.IceCandidate as WebRtcIceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription as WebRtcSessionDescription
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Wrapper around org.webrtc.PeerConnection that implements NativePeerConnection.
 *
 * This class is constructed with only the observer, and the native connection
 * is set later via [initialize]. This allows it to be passed as a
 * PeerConnection.Observer when creating the native connection.
 *
 * Converts WebRTC callback-based APIs to suspending functions using coroutines.
 */
class WebRtcPeerConnectionWrapper(
    private val observer: PeerConnectionObserver
) : NativePeerConnection, PeerConnection.Observer {

    private var _nativeConnection: PeerConnection? = null
    private val nativeConnection: PeerConnection
        get() = _nativeConnection
            ?: throw IllegalStateException("WebRtcPeerConnectionWrapper not initialized. Call initialize() first.")

    // CRITICAL: Must keep strong references to native DataChannels to prevent GC
    // WebRTC native objects can be garbage collected if only Kotlin wrapper holds reference
    private val dataChannels = mutableListOf<DataChannel>()

    /**
     * Initializes this wrapper with the native peer connection.
     * Must be called before using any other methods.
     */
    fun initialize(connection: PeerConnection) {
        _nativeConnection = connection
    }

    override suspend fun createOffer(): SessionDescription {
        return suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation {
                // WebRTC createOffer cannot be cancelled once started; operation will complete but result will be ignored
            }

            val constraints = MediaConstraints().apply {
                mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "false"))
                mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false"))
            }

            nativeConnection.createOffer(object : SdpObserver {
                override fun onCreateSuccess(sdp: WebRtcSessionDescription) {
                    continuation.resume(fromWebRtcSessionDescription(sdp))
                }

                override fun onCreateFailure(error: String) {
                    continuation.resumeWithException(WebRtcException("Failed to create offer: $error"))
                }

                override fun onSetSuccess() {
                    // Not used for createOffer
                }

                override fun onSetFailure(error: String) {
                    // Not used for createOffer
                }
            }, constraints)
        }
    }

    override suspend fun createAnswer(): SessionDescription {
        return suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation {
                // WebRTC createAnswer cannot be cancelled once started; operation will complete but result will be ignored
            }

            val constraints = MediaConstraints().apply {
                mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "false"))
                mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false"))
            }

            nativeConnection.createAnswer(object : SdpObserver {
                override fun onCreateSuccess(sdp: WebRtcSessionDescription) {
                    continuation.resume(fromWebRtcSessionDescription(sdp))
                }

                override fun onCreateFailure(error: String) {
                    continuation.resumeWithException(WebRtcException("Failed to create answer: $error"))
                }

                override fun onSetSuccess() {
                    // Not used for createAnswer
                }

                override fun onSetFailure(error: String) {
                    // Not used for createAnswer
                }
            }, constraints)
        }
    }

    override suspend fun setLocalDescription(description: SessionDescription) {
        return suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation {
                // WebRTC setLocalDescription cannot be cancelled once started; operation will complete but result will be ignored
            }

            val webRtcSdp = toWebRtcSessionDescription(description)

            nativeConnection.setLocalDescription(object : SdpObserver {
                override fun onCreateSuccess(sdp: WebRtcSessionDescription) {
                    // Not used for setLocalDescription
                }

                override fun onCreateFailure(error: String) {
                    // Not used for setLocalDescription
                }

                override fun onSetSuccess() {
                    continuation.resume(Unit)
                }

                override fun onSetFailure(error: String) {
                    continuation.resumeWithException(WebRtcException("Failed to set local description: $error"))
                }
            }, webRtcSdp)
        }
    }

    override suspend fun setRemoteDescription(description: SessionDescription) {
        return suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation {
                // WebRTC setRemoteDescription cannot be cancelled once started; operation will complete but result will be ignored
            }

            val webRtcSdp = toWebRtcSessionDescription(description)

            nativeConnection.setRemoteDescription(object : SdpObserver {
                override fun onCreateSuccess(sdp: WebRtcSessionDescription) {
                    // Not used for setRemoteDescription
                }

                override fun onCreateFailure(error: String) {
                    // Not used for setRemoteDescription
                }

                override fun onSetSuccess() {
                    continuation.resume(Unit)
                }

                override fun onSetFailure(error: String) {
                    continuation.resumeWithException(WebRtcException("Failed to set remote description: $error"))
                }
            }, webRtcSdp)
        }
    }

    override suspend fun addIceCandidate(candidate: IceCandidate) {
        return suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation {
                // WebRTC addIceCandidate cannot be cancelled once started; operation will complete but result will be ignored
            }

            val webRtcCandidate = toWebRtcIceCandidate(candidate)
            nativeConnection.addIceCandidate(webRtcCandidate, object : AddIceObserver {
                override fun onAddSuccess() {
                    continuation.resume(Unit)
                }

                override fun onAddFailure(error: String) {
                    continuation.resumeWithException(WebRtcException("Failed to add ICE candidate: $error"))
                }
            })
        }
    }

    override fun close() {
        // Close all data channels first
        dataChannels.forEach { channel ->
            try {
                channel.close()
            } catch (_: Exception) {
                // Ignore errors during cleanup
            }
        }
        dataChannels.clear()

        // Then close the peer connection
        nativeConnection.close()
    }

    // PeerConnection.Observer implementation

    override fun onSignalingChange(state: PeerConnection.SignalingState) {
        // Not directly mapped to our observer
    }

    override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
        observer.onIceConnectionStateChange(mapIceConnectionState(state))
    }

    override fun onIceConnectionReceivingChange(receiving: Boolean) {
        // Not exposed in our interface
    }

    override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
        // Not directly mapped to our observer
    }

    override fun onIceCandidate(candidate: WebRtcIceCandidate) {
        observer.onIceCandidate(fromWebRtcIceCandidate(candidate))
    }

    override fun onIceCandidatesRemoved(candidates: Array<out WebRtcIceCandidate>) {
        // Not exposed in our interface
    }

    override fun onAddStream(stream: MediaStream) {
        // Not used - we use data channels only
    }

    override fun onRemoveStream(stream: MediaStream) {
        // Not used - we use data channels only
    }

    override fun onDataChannel(channel: DataChannel) {
        // Keep strong reference to prevent native object GC
        dataChannels.add(channel)
        observer.onDataChannel(WebRtcDataChannel(channel))
    }

    override fun onRenegotiationNeeded() {
        // Could be exposed if needed
    }

    override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) {
        // Not used - we use data channels only
    }

    override fun onTrack(transceiver: RtpTransceiver) {
        // Not used - we use data channels only
    }

    override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
        observer.onConnectionStateChange(mapPeerConnectionState(newState))
    }

    companion object {
        /**
         * Maps our IceCandidate to WebRTC IceCandidate.
         */
        fun toWebRtcIceCandidate(candidate: IceCandidate): WebRtcIceCandidate {
            return WebRtcIceCandidate(
                candidate.sdpMid,
                candidate.sdpMLineIndex ?: 0,
                candidate.candidate
            )
        }

        /**
         * Maps WebRTC IceCandidate to our IceCandidate.
         */
        fun fromWebRtcIceCandidate(candidate: WebRtcIceCandidate): IceCandidate {
            return IceCandidate(
                sdpMid = candidate.sdpMid,
                sdpMLineIndex = candidate.sdpMLineIndex,
                candidate = candidate.sdp
            )
        }

        /**
         * Maps our SessionDescription to WebRTC SessionDescription.
         */
        fun toWebRtcSessionDescription(description: SessionDescription): WebRtcSessionDescription {
            val type = when (description.type.lowercase()) {
                "offer" -> WebRtcSessionDescription.Type.OFFER
                "answer" -> WebRtcSessionDescription.Type.ANSWER
                "pranswer" -> WebRtcSessionDescription.Type.PRANSWER
                else -> throw WebRtcException("Unknown SDP type: ${description.type}")
            }
            return WebRtcSessionDescription(type, description.sdp)
        }

        /**
         * Maps WebRTC SessionDescription to our SessionDescription.
         */
        fun fromWebRtcSessionDescription(sdp: WebRtcSessionDescription): SessionDescription {
            return SessionDescription(
                type = sdp.type.canonicalForm(),
                sdp = sdp.description
            )
        }

        /**
         * Maps WebRTC IceConnectionState to our ConnectionState.
         */
        fun mapIceConnectionState(state: PeerConnection.IceConnectionState): ConnectionState {
            return when (state) {
                PeerConnection.IceConnectionState.NEW -> ConnectionState.NEW
                PeerConnection.IceConnectionState.CHECKING -> ConnectionState.CONNECTING
                PeerConnection.IceConnectionState.CONNECTED -> ConnectionState.CONNECTED
                PeerConnection.IceConnectionState.COMPLETED -> ConnectionState.CONNECTED
                PeerConnection.IceConnectionState.FAILED -> ConnectionState.FAILED
                PeerConnection.IceConnectionState.DISCONNECTED -> ConnectionState.DISCONNECTED
                PeerConnection.IceConnectionState.CLOSED -> ConnectionState.CLOSED
            }
        }

        /**
         * Maps WebRTC PeerConnectionState to our ConnectionState.
         */
        fun mapPeerConnectionState(state: PeerConnection.PeerConnectionState): ConnectionState {
            return when (state) {
                PeerConnection.PeerConnectionState.NEW -> ConnectionState.NEW
                PeerConnection.PeerConnectionState.CONNECTING -> ConnectionState.CONNECTING
                PeerConnection.PeerConnectionState.CONNECTED -> ConnectionState.CONNECTED
                PeerConnection.PeerConnectionState.FAILED -> ConnectionState.FAILED
                PeerConnection.PeerConnectionState.DISCONNECTED -> ConnectionState.DISCONNECTED
                PeerConnection.PeerConnectionState.CLOSED -> ConnectionState.CLOSED
            }
        }
    }
}

/**
 * Exception thrown when WebRTC operations fail.
 */
class WebRtcException(message: String) : Exception(message)
