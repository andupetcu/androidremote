package com.androidremote.transport

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** T8a: AR-05, AR-09, AR-04, AR-03 (transport side), AR-10, AR-12, AR-13, C4, C9. */
@OptIn(ExperimentalCoroutinesApi::class)
class T8aTransportTest {

    private val json = Json { ignoreUnknownKeys = true }

    private fun tap(i: Int) = """{"id":"c$i","command":{"type":"TAP","x":0.5,"y":0.5},"timestamp":$i}"""

    // ---- AR-05: no dropped commands under burst ----

    @Test
    fun `100 rapid commands are all delivered in order even before a collector starts`() = runTest {
        val dc = MockDataChannel("commands")
        val channel = DeviceCommandChannel(dc)
        repeat(100) { dc.simulateIncomingText(tap(it)) }

        val received = ArrayList<String>()
        val job = launch { channel.commands.collect { received.add(it.id) } }
        runCurrent()
        job.cancel()

        assertEquals((0 until 100).map { "c$it" }, received)
    }

    @Test
    fun `100 rapid commands are not dropped while the collector is slow`() = runTest {
        val dc = MockDataChannel("commands")
        val channel = DeviceCommandChannel(dc)
        val received = ArrayList<String>()
        val job = launch {
            channel.commands.collect {
                kotlinx.coroutines.delay(10)
                received.add(it.id)
            }
        }
        runCurrent()
        repeat(100) { dc.simulateIncomingText(tap(it)) }
        advanceTimeBy(100 * 10L + 100)
        runCurrent()
        job.cancel()

        assertEquals((0 until 100).map { "c$it" }, received)
    }

    @Test
    fun `local ICE candidates are not dropped in a burst`() = runTest {
        val factory = MockPeerConnectionFactory()
        val pc = PeerConnectionWrapper(factory)
        repeat(100) { factory.mockConnection.simulateIceCandidate(IceCandidate("cand-$it", "0", 0)) }

        val got = ArrayList<String>()
        val job = launch { pc.iceCandidates.collect { got.add(it.candidate) } }
        runCurrent()
        job.cancel()

        assertEquals((0 until 100).map { "cand-$it" }, got)
    }

    @Test
    fun `two data channels arriving back to back are both delivered`() = runTest {
        val factory = MockPeerConnectionFactory()
        val pc = PeerConnectionWrapper(factory)
        factory.mockConnection.simulateDataChannel(MockDataChannel("commands"))
        factory.mockConnection.simulateDataChannel(MockDataChannel("video"))

        val labels = ArrayList<String>()
        val job = launch { pc.dataChannels.collect { labels.add(it.label) } }
        runCurrent()
        job.cancel()

        assertEquals(listOf("commands", "video"), labels)
    }

    // ---- AR-09: bad message does not kill the collector ----

    @Test
    fun `a malformed message does not stop later commands`() = runTest {
        val dc = MockDataChannel("commands")
        val channel = DeviceCommandChannel(dc)
        val received = ArrayList<String>()
        val job = launch { channel.commands.collect { received.add(it.id) } }
        runCurrent()

        dc.simulateIncomingText("{not json")
        dc.simulateIncomingText("""{"id":"x","command":{"type":"NOPE"}}""")
        dc.simulateIncomingText(tap(1))
        runCurrent()
        job.cancel()

        assertEquals(listOf("c1"), received)
    }

    @Test
    fun `a failing ICE candidate does not stop the remote candidate collector`() = runTest {
        val provider = MockWebSocketProvider()
        val factory = MockPeerConnectionFactory()
        val session = RemoteSession("ws://localhost:3000/ws", "dev", provider, factory, backgroundScope)
        session.connect()
        session.startAsAnswerer()
        runCurrent()

        factory.mockConnection.failNextAddCandidate = true
        val msg = { n: Int -> """{"type":"ice-candidate","candidate":{"candidate":"c$n","sdpMid":"0","sdpMLineIndex":0}}""" }
        provider.simulateIncomingMessage(msg(1))
        provider.simulateIncomingMessage(msg(2))
        runCurrent()

        assertEquals(listOf("c2"), factory.mockConnection.addedCandidates.map { it.candidate })
    }

    // ---- AR-18 follow-up: no raw text in logs ----

    @Test
    fun `an undecodable command never logs the raw message text`() {
        val dc = MockDataChannel("commands")
        DeviceCommandChannel(dc)
        val old = System.err
        val buf = java.io.ByteArrayOutputStream()
        System.setErr(java.io.PrintStream(buf))
        try {
            dc.simulateIncomingText("""{"type":"TYPE_TEXT","text":"hunter2-secret""")
        } finally {
            System.setErr(old)
        }
        assertFalse(buf.toString().contains("hunter2"))
    }

    // ---- C9: control messages ----

    @Test
    fun `REQUEST_KEYFRAME surfaces as a control message and not as a command`() = runTest {
        val dc = MockDataChannel("commands")
        val channel = DeviceCommandChannel(dc)
        val controls = ArrayList<ControlMessage>()
        val commands = ArrayList<String>()
        val j1 = launch { channel.controlMessages.collect { controls.add(it) } }
        val j2 = launch { channel.commands.collect { commands.add(it.id) } }
        runCurrent()

        dc.simulateIncomingText("""{"type":"REQUEST_KEYFRAME"}""")
        runCurrent()
        j1.cancel(); j2.cancel()

        assertEquals(listOf<ControlMessage>(ControlMessage.RequestKeyFrame), controls)
        assertTrue(commands.isEmpty())
    }

    @Test
    fun `sendScreenInfo and sendCaptureFailed use the C9 and C8 JSON shapes`() {
        val dc = MockDataChannel("commands")
        val channel = DeviceCommandChannel(dc)
        assertTrue(channel.sendScreenInfo(1080, 2400, 90))
        assertTrue(channel.sendCaptureFailed("consent_required"))

        val info = json.parseToJsonElement(dc.sentTextMessages[0]).let { it as kotlinx.serialization.json.JsonObject }
        assertEquals("SCREEN_INFO", (info["type"] as JsonPrimitive).content)
        assertEquals(1080, (info["width"] as JsonPrimitive).content.toInt())
        assertEquals(2400, (info["height"] as JsonPrimitive).content.toInt())
        assertEquals(90, (info["rotation"] as JsonPrimitive).content.toInt())
        val failed = json.parseToJsonElement(dc.sentTextMessages[1]) as kotlinx.serialization.json.JsonObject
        assertEquals("CAPTURE_FAILED", (failed["type"] as JsonPrimitive).content)
        assertEquals("consent_required", (failed["reason"] as JsonPrimitive).content)
    }

    @Test
    fun `video goes on the video channel when open and falls back to commands otherwise`() = runTest {
        val provider = MockWebSocketProvider()
        val factory = MockPeerConnectionFactory()
        val session = RemoteSession("ws://localhost:3000/ws", "dev", provider, factory, backgroundScope, createCommandChannel = false)
        session.connect()
        runCurrent()
        val commands = MockDataChannel("commands")
        factory.mockConnection.simulateDataChannel(commands)
        runCurrent()
        val vc = session.videoChannel!!

        // No video channel yet: fallback to commands.
        assertTrue(vc.sendFrame(byteArrayOf(1, 2, 3), 1L, true))
        assertEquals(1, commands.sentBinaryMessages.size)

        val video = MockDataChannel("video")
        factory.mockConnection.simulateDataChannel(video)
        runCurrent()
        assertTrue(vc.sendFrame(byteArrayOf(4, 5, 6), 2L, false))
        assertEquals(1, commands.sentBinaryMessages.size)
        assertEquals(1, video.sentBinaryMessages.size)
    }

    // ---- AR-04: ICE disconnected is transient ----

    private suspend fun kotlinx.coroutines.test.TestScope.connectedSession(
        graceMs: Long = 10_000
    ): Pair<RemoteSession, MockPeerConnectionFactory> {
        val provider = MockWebSocketProvider()
        val factory = MockPeerConnectionFactory()
        val session = RemoteSession(
            "ws://localhost:3000/ws", "dev", provider, factory, backgroundScope,
            iceDisconnectGraceMs = graceMs
        )
        session.connect()
        runCurrent()
        factory.mockConnection.simulateConnectionStateChange(ConnectionState.CONNECTED)
        runCurrent()
        assertEquals(SessionState.CONNECTED, session.state.value)
        return session to factory
    }

    @Test
    fun `ICE disconnected stays connected during the grace period`() = runTest {
        val (session, factory) = connectedSession()
        factory.mockConnection.simulateConnectionStateChange(ConnectionState.DISCONNECTED)
        runCurrent()
        advanceTimeBy(9_000)
        assertEquals(SessionState.CONNECTED, session.state.value)
    }

    @Test
    fun `ICE disconnected that does not recover fails after the grace period`() = runTest {
        val (session, factory) = connectedSession()
        factory.mockConnection.simulateConnectionStateChange(ConnectionState.DISCONNECTED)
        runCurrent()
        advanceTimeBy(10_001)
        runCurrent()
        assertEquals(SessionState.FAILED, session.state.value)
    }

    @Test
    fun `ICE recovery within the grace period cancels the failure`() = runTest {
        val (session, factory) = connectedSession()
        factory.mockConnection.simulateConnectionStateChange(ConnectionState.DISCONNECTED)
        runCurrent()
        advanceTimeBy(5_000)
        factory.mockConnection.simulateConnectionStateChange(ConnectionState.CONNECTED)
        runCurrent()
        advanceTimeBy(20_000)
        runCurrent()
        assertEquals(SessionState.CONNECTED, session.state.value)
    }

    @Test
    fun `explicit ICE failed is reported immediately`() = runTest {
        val (session, factory) = connectedSession()
        factory.mockConnection.simulateConnectionStateChange(ConnectionState.FAILED)
        runCurrent()
        assertEquals(SessionState.FAILED, session.state.value)
    }

    // ---- AR-03: peer left is observable ----

    @Test
    fun `peer left and joined signaling messages are exposed by the session`() = runTest {
        val provider = MockWebSocketProvider()
        val factory = MockPeerConnectionFactory()
        val session = RemoteSession("ws://localhost:3000/ws", "dev", provider, factory, backgroundScope)
        session.connect()
        session.startAsAnswerer()
        var left = 0
        val roles = ArrayList<String>()
        backgroundScope.launch { session.peerLeft.collect { left++ } }
        backgroundScope.launch { session.peerJoined.collect { roles.add(it) } }
        runCurrent()

        provider.simulateIncomingMessage("""{"type":"peer-joined","role":"controller"}""")
        provider.simulateIncomingMessage("""{"type":"peer-left"}""")
        runCurrent()

        assertEquals(listOf("controller"), roles)
        assertEquals(1, left)
    }

    // ---- C4: auth header on the WebSocket upgrade ----

    @Test
    fun `signaling upgrade carries the Authorization bearer header`() = runTest {
        val provider = MockWebSocketProvider()
        val client = SignalingClient("ws://h/ws", "dev", provider, backgroundScope, authToken = "tok-123")
        client.connect()
        assertEquals("Bearer tok-123", provider.lastConnectionHeaders()["Authorization"])
    }

    @Test
    fun `signaling upgrade has no Authorization header when no token is set`() = runTest {
        val provider = MockWebSocketProvider()
        SignalingClient("ws://h/ws", "dev", provider, backgroundScope).connect()
        assertNull(provider.lastConnectionHeaders()["Authorization"])
    }

    @Test
    fun `session passes its auth token to the signaling upgrade`() = runTest {
        val provider = MockWebSocketProvider()
        val session = RemoteSession(
            "ws://h/ws", "dev", provider, MockPeerConnectionFactory(), backgroundScope,
            authToken = "tok-xyz"
        )
        session.connect()
        assertEquals("Bearer tok-xyz", provider.lastConnectionHeaders()["Authorization"])
    }

    // ---- AR-10: signaling URL derivation ----

    @Test
    fun `http base url becomes ws with the ws path`() {
        assertEquals("ws://192.168.1.10:7899/ws", SignalingUrls.fromServerBase("http://192.168.1.10:7899"))
    }

    @Test
    fun `https base url becomes wss`() {
        assertEquals("wss://mdm.example.com/ws", SignalingUrls.fromServerBase("https://mdm.example.com"))
    }

    @Test
    fun `trailing slash and existing ws urls are normalised`() {
        assertEquals("ws://h:1/ws", SignalingUrls.fromServerBase("http://h:1/"))
        assertEquals("wss://h/ws", SignalingUrls.fromServerBase("wss://h/ws"))
        assertEquals("ws://h/ws", SignalingUrls.fromServerBase("ws://h"))
    }

    @Test
    fun `an existing path and query are preserved`() {
        assertEquals("ws://h:3000/signaling?x=1", SignalingUrls.fromServerBase("ws://h:3000/signaling?x=1"))
    }

    @Test
    fun `unsupported or malformed base urls are rejected`() {
        assertThrows(IllegalArgumentException::class.java) { SignalingUrls.fromServerBase("ftp://h") }
        assertThrows(IllegalArgumentException::class.java) { SignalingUrls.fromServerBase("not a url") }
        assertThrows(IllegalArgumentException::class.java) { SignalingUrls.fromServerBase("") }
    }

    // ---- AR-13: ICE servers from the START_REMOTE payload ----

    @Test
    fun `iceServers payload is parsed with urls username and credential`() {
        val payload = buildJsonArray {
            add(buildJsonObject { put("urls", "stun:stun.example.com:3478") })
            add(buildJsonObject {
                put("urls", buildJsonArray { add(JsonPrimitive("turn:t.example.com:3478")); add(JsonPrimitive("turns:t.example.com:5349")) })
                put("username", "1700000000:dev")
                put("credential", "s3cr3t")
            })
        }
        val config = IceServerParser.parseConfig(payload)
        assertEquals(2, config.iceServers.size)
        assertEquals(listOf("stun:stun.example.com:3478"), config.iceServers[0].urls)
        assertEquals(listOf("turn:t.example.com:3478", "turns:t.example.com:5349"), config.iceServers[1].urls)
        assertEquals("1700000000:dev", config.iceServers[1].username)
        assertEquals("s3cr3t", config.iceServers[1].credential)
    }

    @Test
    fun `missing or invalid iceServers falls back to the default config`() {
        assertSame(RemoteSession.DEFAULT_CONFIG, IceServerParser.parseConfig(null))
        assertSame(RemoteSession.DEFAULT_CONFIG, IceServerParser.parseConfig(JsonPrimitive("junk")))
        assertSame(RemoteSession.DEFAULT_CONFIG, IceServerParser.parseConfig(buildJsonArray { }))
    }

    @Test
    fun `iceServers json string form is parsed`() {
        val config = IceServerParser.parseConfigFromString("""[{"urls":["turn:t:3478"],"username":"u","credential":"c"}]""")
        assertEquals("u", config.iceServers.single().username)
        assertSame(RemoteSession.DEFAULT_CONFIG, IceServerParser.parseConfigFromString("{oops"))
    }

    @Test
    fun `default config carries no TURN credentials`() {
        assertTrue(RemoteSession.DEFAULT_CONFIG.iceServers.none { it.username != null || it.credential != null })
    }
}
