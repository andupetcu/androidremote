package com.androidremote.app.api

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json

/**
 * HTTP client for the pairing API.
 */
class PairingApiClient(
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
     * Initiate pairing request.
     * Returns pairing code and QR data for display.
     */
    suspend fun initiatePairing(deviceName: String, deviceModel: String): PairingInitResponse {
        return httpClient.post("$baseUrl/api/pair/initiate") {
            contentType(ContentType.Application.Json)
            setBody(PairingInitRequest(deviceName, deviceModel))
        }.body()
    }

    /**
     * Get current pairing status.
     * Poll this until status is "completed" or "expired".
     */
    suspend fun getStatus(deviceId: String): PairingStatusResponse {
        return httpClient.get("$baseUrl/api/pair/status/$deviceId").body()
    }

    /**
     * Close the HTTP client.
     */
    fun close() {
        httpClient.close()
    }
}
