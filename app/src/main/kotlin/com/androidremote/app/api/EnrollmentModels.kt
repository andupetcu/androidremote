package com.androidremote.app.api

import kotlinx.serialization.Serializable

/**
 * Request to enroll a device using a token.
 */
@Serializable
data class EnrollmentRequest(
    val token: String,
    val deviceName: String,
    val deviceModel: String? = null,
    val androidVersion: String? = null
)

/**
 * Response from device enrollment.
 */
@Serializable
data class EnrollmentResponse(
    val deviceId: String,
    val sessionToken: String,
    val serverUrl: String
)

/**
 * Error response from enrollment API.
 */
@Serializable
data class EnrollmentErrorResponse(
    val error: String
)
