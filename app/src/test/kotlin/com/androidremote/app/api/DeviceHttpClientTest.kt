package com.androidremote.app.api

import com.androidremote.app.testsupport.LogStub
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.client.request.get
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class DeviceHttpClientTest {
    private val base = "https://mdm.example.com"
    private val seen = mutableListOf<HttpRequestData>()
    private var token: String? = "tok-1"
    private var nextStatus = HttpStatusCode.OK
    private var nextBody = "{}"

    @BeforeEach fun setUp() = LogStub.install()
    @AfterEach fun tearDown() = LogStub.uninstall()

    private fun api(): CommandApiClient {
        val engine = MockEngine { req ->
            seen += req
            respond(
                nextBody, nextStatus,
                headersOf(HttpHeaders.ContentType, "application/json")
            )
        }
        val http = DeviceHttpClient.create(base, { token }, engine)
        return CommandApiClient(base, "device-1", http)
    }

    @Test
    fun `every device call carries the session token header`() = runTest {
        val client = api()

        nextBody = """{"commands":[]}"""
        client.getPendingCommands()
        nextBody = "{}"
        client.markExecuting("c1")
        client.markCompleted("c1")
        client.markFailed("c2", "boom")
        client.postTelemetry("""{"batteryLevel":50}""")
        client.postApps("""{"apps":[]}""")
        nextBody = """{"updates":[]}"""
        client.getAppUpdates()

        assertEquals(7, seen.size)
        seen.forEach {
            assertEquals("tok-1", it.headers["X-Session-Token"], "missing token on ${it.method.value} ${it.url}")
            assertTrue(it.url.encodedPath.startsWith("/api/devices/device-1/"))
        }
    }

    @Test
    fun `token is read per request so a rotated token is used`() = runTest {
        val client = api()
        nextBody = """{"commands":[]}"""
        client.getPendingCommands()
        token = "tok-2"
        client.getPendingCommands()
        assertEquals(listOf("tok-1", "tok-2"), seen.map { it.headers["X-Session-Token"] })
    }

    @Test
    fun `token is not sent to a different host`() = runTest {
        val engine = MockEngine { req -> seen += req; respond("ok", HttpStatusCode.OK) }
        val http = DeviceHttpClient.create(base, { token }, engine)
        http.get("https://cdn.other.net/app.apk")
        http.get("$base/api/packages/x/download")
        assertNull(seen[0].headers["X-Session-Token"])
        assertEquals("tok-1", seen[1].headers["X-Session-Token"])
    }

    @Test
    fun `401 and 404 on poll are reported as invalid enrollment`() = runTest {
        val client = api()
        nextStatus = HttpStatusCode.Unauthorized
        val e1 = assertThrows(CommandApiException::class.java) { kotlinx.coroutines.runBlocking { client.getPendingCommands() } }
        assertEquals(CommandApiErrorType.UNAUTHORIZED, e1.errorType)
        assertTrue(e1.isEnrollmentInvalid)

        nextStatus = HttpStatusCode.NotFound
        val e2 = assertThrows(CommandApiException::class.java) { kotlinx.coroutines.runBlocking { client.getPendingCommands() } }
        assertEquals(CommandApiErrorType.DEVICE_NOT_FOUND, e2.errorType)
        assertTrue(e2.isEnrollmentInvalid)

        nextStatus = HttpStatusCode.InternalServerError
        val e3 = assertThrows(CommandApiException::class.java) { kotlinx.coroutines.runBlocking { client.getPendingCommands() } }
        assertFalse(e3.isEnrollmentInvalid)
    }
}
