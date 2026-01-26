package com.androidremote.transport

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator

/**
 * WebRTC session description (SDP offer/answer).
 */
@Serializable
data class SessionDescription(
    val type: String,
    val sdp: String
)

/**
 * WebRTC ICE candidate for peer connectivity.
 * Matches the server's IceCandidate structure.
 */
@Serializable
data class IceCandidate(
    val candidate: String,
    val sdpMid: String? = null,
    val sdpMLineIndex: Int? = null,
    val usernameFragment: String? = null
)

/**
 * Signaling messages exchanged between peers via the server.
 * Uses "type" as discriminator to match server protocol.
 */
@Serializable
@JsonClassDiscriminator("type")
sealed class SignalingMessage {

    /**
     * Join a room with a specific role.
     */
    @Serializable
    @SerialName("join")
    data class Join(
        val deviceId: String,
        val role: String  // "device" or "controller"
    ) : SignalingMessage()

    /**
     * SDP offer from the controller (offerer).
     */
    @Serializable
    @SerialName("offer")
    data class Offer(val sdp: String) : SignalingMessage()

    /**
     * SDP answer from the device (answerer).
     */
    @Serializable
    @SerialName("answer")
    data class Answer(val sdp: String) : SignalingMessage()

    /**
     * ICE candidate for peer connectivity.
     */
    @Serializable
    @SerialName("ice-candidate")
    data class Ice(val candidate: IceCandidate) : SignalingMessage()

    /**
     * Notification that a peer joined the room.
     */
    @Serializable
    @SerialName("peer-joined")
    data class PeerJoined(val role: String) : SignalingMessage()

    /**
     * Notification that a peer left the room.
     */
    @Serializable
    @SerialName("peer-left")
    data object PeerLeft : SignalingMessage()

    /**
     * Error message from the server.
     */
    @Serializable
    @SerialName("error")
    data class Error(val message: String) : SignalingMessage()
}

/**
 * Exception thrown when signaling connection fails.
 */
class SignalingConnectionException(
    message: String,
    cause: Throwable? = null
) : Exception(message, cause)
