package com.androidremote.app.api

import kotlinx.serialization.Serializable

/**
 * Request to initiate pairing.
 */
@Serializable
data class PairingInitRequest(
    val deviceName: String,
    val deviceModel: String
)

/**
 * Response from pairing initiation.
 */
@Serializable
data class PairingInitResponse(
    val pairingCode: String,
    val qrCodeData: String,
    val expiresAt: Long,
    val deviceId: String
)

/**
 * Pairing status response.
 */
@Serializable
data class PairingStatusResponse(
    val status: String, // "pending", "completed", "expired"
    val sessionToken: String? = null,
    val serverUrl: String? = null
)

/**
 * Request to complete pairing (called by controller).
 */
@Serializable
data class PairingCompleteRequest(
    val pairingCode: String,
    val controllerName: String
)

/**
 * Response from pairing completion.
 */
@Serializable
data class PairingCompleteResponse(
    val success: Boolean,
    val sessionToken: String? = null,
    val serverUrl: String? = null,
    val errorMessage: String? = null
)
