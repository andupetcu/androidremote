package com.androidremote.app.api

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Test

class PairingApiClientTest {

    private fun createMockClient(responseJson: String, status: HttpStatusCode = HttpStatusCode.OK): HttpClient {
        return HttpClient(MockEngine) {
            engine {
                addHandler { _ ->
                    respond(
                        content = responseJson,
                        status = status,
                        headers = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                    )
                }
            }
            install(ContentNegotiation) {
                json(Json { ignoreUnknownKeys = true })
            }
        }
    }

    @Test
    fun `initiatePairing returns pairing info`() = runTest {
        val responseJson = """
            {
                "pairingCode": "ABC123",
                "qrCodeData": "remote://pair?code=ABC123&device=test-device",
                "expiresAt": 1700000000000,
                "deviceId": "device-123"
            }
        """.trimIndent()

        val client = PairingApiClient(
            baseUrl = "http://localhost:8080",
            httpClient = createMockClient(responseJson)
        )

        val result = client.initiatePairing("Test Device", "Pixel 7")

        assertNotNull(result)
        assertEquals("ABC123", result.pairingCode)
        assertEquals("device-123", result.deviceId)
        assertEquals("remote://pair?code=ABC123&device=test-device", result.qrCodeData)
        assertEquals(1700000000000L, result.expiresAt)
    }

    @Test
    fun `getStatus returns pending status`() = runTest {
        val responseJson = """
            {
                "status": "pending"
            }
        """.trimIndent()

        val client = PairingApiClient(
            baseUrl = "http://localhost:8080",
            httpClient = createMockClient(responseJson)
        )

        val result = client.getStatus("device-123")

        assertEquals("pending", result.status)
        assertEquals(null, result.sessionToken)
        assertEquals(null, result.serverUrl)
    }

    @Test
    fun `getStatus returns completed with session info`() = runTest {
        val responseJson = """
            {
                "status": "completed",
                "sessionToken": "session-token-xyz",
                "serverUrl": "ws://example.com/signaling"
            }
        """.trimIndent()

        val client = PairingApiClient(
            baseUrl = "http://localhost:8080",
            httpClient = createMockClient(responseJson)
        )

        val result = client.getStatus("device-123")

        assertEquals("completed", result.status)
        assertEquals("session-token-xyz", result.sessionToken)
        assertEquals("ws://example.com/signaling", result.serverUrl)
    }

    @Test
    fun `getStatus returns expired status`() = runTest {
        val responseJson = """
            {
                "status": "expired"
            }
        """.trimIndent()

        val client = PairingApiClient(
            baseUrl = "http://localhost:8080",
            httpClient = createMockClient(responseJson)
        )

        val result = client.getStatus("device-123")

        assertEquals("expired", result.status)
    }
}
