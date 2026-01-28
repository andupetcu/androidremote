package com.androidremote.app.api

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json

/**
 * HTTP client for the MDM enrollment API.
 *
 * Devices enroll using admin-generated tokens. On success, the device receives
 * a deviceId and sessionToken for future communication with the server.
 */
class EnrollmentApiClient(
    private val baseUrl: String,
    private val httpClient: HttpClient = createDefaultClient()
) {
    companion object {
        fun createDefaultClient(): HttpClient {
            return HttpClient(OkHttp) {
                install(ContentNegotiation) {
                    json(Json {
                        ignoreUnknownKeys = true
                        isLenient = true
                    })
                }
            }
        }
    }

    /**
     * Enroll device using an admin-provided token.
     *
     * @param token 8-character enrollment token (case-insensitive)
     * @param deviceName Display name for the device
     * @param deviceModel Device model (e.g., "Google Pixel 8")
     * @param androidVersion Android version string
     * @return EnrollmentResponse on success
     * @throws EnrollmentException on failure
     */
    suspend fun enrollDevice(
        token: String,
        deviceName: String,
        deviceModel: String? = null,
        androidVersion: String? = null
    ): EnrollmentResponse {
        val response: HttpResponse = httpClient.post("$baseUrl/api/enroll/device") {
            contentType(ContentType.Application.Json)
            setBody(
                EnrollmentRequest(
                    token = token.uppercase(), // Server is case-insensitive, but uppercase is canonical
                    deviceName = deviceName,
                    deviceModel = deviceModel,
                    androidVersion = androidVersion
                )
            )
        }

        return when (response.status) {
            HttpStatusCode.Created -> response.body()
            HttpStatusCode.BadRequest -> {
                val error: EnrollmentErrorResponse = response.body()
                throw EnrollmentException(error.error, EnrollmentErrorType.VALIDATION)
            }
            HttpStatusCode.Unauthorized -> {
                throw EnrollmentException(
                    "Invalid, expired, or exhausted enrollment token",
                    EnrollmentErrorType.INVALID_TOKEN
                )
            }
            else -> {
                throw EnrollmentException(
                    "Enrollment failed (${response.status})",
                    EnrollmentErrorType.SERVER_ERROR
                )
            }
        }
    }

    /**
     * Close the HTTP client.
     */
    fun close() {
        httpClient.close()
    }
}

/**
 * Types of enrollment errors for UI handling.
 */
enum class EnrollmentErrorType {
    INVALID_TOKEN,   // Token doesn't exist, expired, or exhausted
    VALIDATION,      // Missing required fields
    NETWORK,         // Connection error
    SERVER_ERROR     // Unexpected server error
}

/**
 * Exception thrown during enrollment.
 */
class EnrollmentException(
    override val message: String,
    val errorType: EnrollmentErrorType
) : Exception(message)
