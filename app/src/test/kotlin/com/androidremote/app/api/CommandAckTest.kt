package com.androidremote.app.api

import com.androidremote.app.testsupport.LogStub
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class CommandAckTest {
    @BeforeEach fun setUp() = LogStub.install()
    @AfterEach fun tearDown() = LogStub.uninstall()

    private fun client(statuses: List<HttpStatusCode>, calls: MutableList<String> = mutableListOf()): CommandApiClient {
        var i = 0
        val engine = MockEngine { req ->
            calls += req.body.toString()
            val s = statuses[minOf(i++, statuses.lastIndex)]
            respond("{}", s)
        }
        return CommandApiClient("https://s", "d1", DeviceHttpClient.create("https://s", { "t" }, engine))
    }

    @Test
    fun `ok ack is OK`() = runTest {
        assertEquals(AckResult.OK, client(listOf(HttpStatusCode.OK)).markCompleted("c"))
    }

    @Test
    fun `5xx then 200 is retried and succeeds`() = runTest {
        val calls = mutableListOf<String>()
        val r = client(listOf(HttpStatusCode.BadGateway, HttpStatusCode.OK), calls).markCompleted("c")
        assertEquals(AckResult.OK, r)
        assertEquals(2, calls.size)
    }

    @Test
    fun `persistent 5xx gives RETRY_LATER after bounded attempts`() = runTest {
        val calls = mutableListOf<String>()
        val r = client(listOf(HttpStatusCode.ServiceUnavailable), calls).markCompleted("c")
        assertEquals(AckResult.RETRY_LATER, r)
        assertEquals(3, calls.size)
    }

    @Test
    fun `404 is a permanent rejection and is not retried`() = runTest {
        val calls = mutableListOf<String>()
        val r = client(listOf(HttpStatusCode.NotFound), calls).markExecuting("c")
        assertEquals(AckResult.REJECTED, r)
        assertEquals(1, calls.size)
    }

    @Test
    fun `409 conflict is a permanent rejection`() = runTest {
        assertEquals(AckResult.REJECTED, client(listOf(HttpStatusCode.Conflict)).markExecuting("c"))
    }

    @Test
    fun `401 is UNAUTHORIZED`() = runTest {
        assertEquals(AckResult.UNAUTHORIZED, client(listOf(HttpStatusCode.Unauthorized)).markExecuting("c"))
    }

    @Test
    fun `network exception gives RETRY_LATER`() = runTest {
        val engine = MockEngine { throw java.io.IOException("down") }
        val c = CommandApiClient("https://s", "d1", DeviceHttpClient.create("https://s", { "t" }, engine))
        assertEquals(AckResult.RETRY_LATER, c.markCompleted("c"))
    }
}
