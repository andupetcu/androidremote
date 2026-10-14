package com.androidremote.app.service

import com.androidremote.app.controller.SessionState
import com.androidremote.app.testsupport.LogStub
import com.google.common.truth.Truth.assertThat
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

/** T8a: AR-15, AR-10 (no stuck service), AR-06 (dispatcher), AR-13 (ICE fetch). */
class SessionServiceLogicTest {

    @BeforeEach fun setUp() = LogStub.install()
    @AfterEach fun tearDown() = LogStub.uninstall()

    private val connected = SessionState.Connected("dev")

    @Test
    fun `a stale Connected replayed after a new start does not start capture`() {
        val c = CaptureCoordinator()
        c.beginSession(autoStarted = true)
        assertThat(c.onState(connected)).isEqualTo(CaptureAction.NONE) // the old session's value
        assertThat(c.onState(SessionState.Connecting)).isEqualTo(CaptureAction.NONE)
        assertThat(c.onState(connected)).isEqualTo(CaptureAction.START_CAPTURE)
    }

    @Test
    fun `capture is started once per session and not again on reconnect`() {
        val c = CaptureCoordinator()
        c.beginSession(autoStarted = true)
        c.onState(SessionState.Connecting)
        assertThat(c.onState(connected)).isEqualTo(CaptureAction.START_CAPTURE)
        assertThat(c.onState(SessionState.Reconnecting(1, 5))).isEqualTo(CaptureAction.NONE)
        assertThat(c.onState(connected)).isEqualTo(CaptureAction.NONE)
    }

    @Test
    fun `a failed capture start can be retried on the next Connected`() {
        val c = CaptureCoordinator()
        c.beginSession(autoStarted = true)
        c.onState(SessionState.Connecting)
        c.onState(connected)
        c.onCaptureStartFailed()
        c.onState(SessionState.Reconnecting(1, 5))
        assertThat(c.onState(connected)).isEqualTo(CaptureAction.START_CAPTURE)
    }

    @Test
    fun `a new START_REMOTE while capture is active first stops the old capture`() {
        val c = CaptureCoordinator()
        c.beginSession(autoStarted = true)
        c.onState(SessionState.Connecting)
        c.onState(connected)
        assertThat(c.beginSession(autoStarted = true)).isEqualTo(CaptureAction.STOP_CAPTURE)
        assertThat(c.onState(connected)).isEqualTo(CaptureAction.NONE)
        c.onState(SessionState.Connecting)
        assertThat(c.onState(connected)).isEqualTo(CaptureAction.START_CAPTURE)
    }

    @Test
    fun `error of an auto started session stops capture and the service`() {
        val c = CaptureCoordinator()
        c.beginSession(autoStarted = true)
        c.onState(SessionState.Connecting)
        c.onState(connected)
        assertThat(c.onState(SessionState.Error("x"))).isEqualTo(CaptureAction.STOP_CAPTURE_AND_SERVICE)
    }

    @Test
    fun `a failed connect that never produced capture still ends the service`() {
        val c = CaptureCoordinator()
        c.beginSession(autoStarted = true)
        c.onState(SessionState.Connecting)
        assertThat(c.onState(SessionState.Error("Invalid WebSocket URL"))).isEqualTo(CaptureAction.STOP_CAPTURE_AND_SERVICE)
    }

    @Test
    fun `a session started from the activity never stops the service`() {
        val c = CaptureCoordinator()
        c.beginSession(autoStarted = false)
        c.onState(SessionState.Connecting)
        assertThat(c.onState(SessionState.Error("x"))).isEqualTo(CaptureAction.NONE)
    }

    @Test
    fun `input dispatcher runs on its own thread that is not the caller`() = runTest {
        val d = InputDispatcher.create()
        try {
            val name = kotlinx.coroutines.withContext(d.dispatcher) { Thread.currentThread().name }
            assertThat(name).isEqualTo(InputDispatcher.THREAD_NAME)
            assertThat(name).isNotEqualTo(Thread.currentThread().name)
            assertThat(name).doesNotContain("main")
        } finally {
            d.close()
        }
    }

    @Test
    fun `ice servers response is parsed into a peer connection config`() = runTest {
        val engine = MockEngine { req ->
            assertThat(req.url.encodedPath).isEqualTo("/api/ice-servers")
            respond(
                """{"iceServers":[{"urls":"stun:s:3478"},{"urls":["turn:t:3478"],"username":"1:d","credential":"c"}]}""",
                HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json")
            )
        }
        val cfg = IceServersFetcher.fetch(HttpClient(engine), "https://mdm.example.com")
        assertThat(cfg.iceServers).hasSize(2)
        assertThat(cfg.iceServers[1].username).isEqualTo("1:d")
    }

    @Test
    fun `ice servers fetch failure falls back to the default config`() = runTest {
        val engine = MockEngine { respond("nope", HttpStatusCode.InternalServerError) }
        val cfg = IceServersFetcher.fetch(HttpClient(engine), "https://mdm.example.com")
        assertThat(cfg).isSameInstanceAs(com.androidremote.transport.RemoteSession.DEFAULT_CONFIG)
    }
}
