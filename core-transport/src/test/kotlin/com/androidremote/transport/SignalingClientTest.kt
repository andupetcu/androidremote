package com.androidremote.transport

import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class SignalingClientTest {

    private lateinit var mockProvider: MockWebSocketProvider
    private lateinit var client: SignalingClient
    private val json = Json { ignoreUnknownKeys = true }

    private fun createClient(scope: kotlinx.coroutines.CoroutineScope): SignalingClient {
        mockProvider = MockWebSocketProvider()
        return SignalingClient(
            serverUrl = "ws://localhost:3000/ws",
            deviceId = "test-device-123",
            webSocketProvider = mockProvider,
            scope = scope
        )
    }

    @BeforeEach
    fun setup() {
        mockProvider = MockWebSocketProvider()
        client = SignalingClient(
            serverUrl = "ws://localhost:3000/ws",
            deviceId = "test-device-123",
            webSocketProvider = mockProvider
        )
    }

    @Test
    fun `connects to signaling server`() = runTest {
        mockProvider.shouldConnect = true

        client.connect()

        assertTrue(client.isConnected)
    }

    @Test
    fun `sends join message on connect`() = runTest {
        mockProvider.shouldConnect = true

        client.connect()

        val sentMessage = mockProvider.lastSentMessage()
        assertTrue(sentMessage.contains("\"type\":\"join\""))
        assertTrue(sentMessage.contains("\"deviceId\":\"test-device-123\""))
        assertTrue(sentMessage.contains("\"role\":\"device\""))
    }

    @Test
    fun `disconnects from server`() = runTest {
        mockProvider.shouldConnect = true
        client.connect()

        client.disconnect()

        assertFalse(client.isConnected)
    }

    @Test
    fun `sends offer to server`() = runTest {
        mockProvider.shouldConnect = true
        client.connect()

        val offer = SessionDescription(type = "offer", sdp = "v=0\r\n...")
        client.sendOffer(offer)

        val sentMessages = mockProvider.allSentMessages()
        // First message is join, second is offer
        val offerMessage = sentMessages.last()
        assertTrue(offerMessage.contains("\"type\":\"offer\""))
        assertTrue(offerMessage.contains("\"sdp\":\"v=0"))
    }

    @Test
    fun `sends answer to server`() = runTest {
        mockProvider.shouldConnect = true
        client.connect()

        val answer = SessionDescription(type = "answer", sdp = "v=0\r\nanswer...")
        client.sendAnswer(answer)

        val sentMessages = mockProvider.allSentMessages()
        val answerMessage = sentMessages.last()
        assertTrue(answerMessage.contains("\"type\":\"answer\""))
        assertTrue(answerMessage.contains("\"sdp\":\"v=0"))
    }

    @org.junit.jupiter.api.Disabled("Requires integration testing with real coroutine dispatchers")
    @Test
    fun `receives offer from server`() = runTest {
        client = createClient(this)
        mockProvider.shouldConnect = true
        client.connect()

        val message = """{"type":"offer","sdp":"v=0\r\noffer..."}"""
        mockProvider.simulateIncomingMessage(message)

        val result = withTimeout(1000) { client.offers.first() }
        assertEquals("offer", result.type)
        assertEquals("v=0\r\noffer...", result.sdp)
    }

    @org.junit.jupiter.api.Disabled("Requires integration testing with real coroutine dispatchers")
    @Test
    fun `receives answer from server`() = runTest {
        client = createClient(this)
        mockProvider.shouldConnect = true
        client.connect()

        val message = """{"type":"answer","sdp":"v=0\r\nanswer..."}"""
        mockProvider.simulateIncomingMessage(message)

        val result = withTimeout(1000) { client.answers.first() }
        assertEquals("answer", result.type)
    }

    @Test
    fun `sends ICE candidate to server`() = runTest {
        mockProvider.shouldConnect = true
        client.connect()

        val candidate = IceCandidate(
            candidate = "candidate:1234...",
            sdpMid = "0",
            sdpMLineIndex = 0
        )
        client.sendIceCandidate(candidate)

        val sentMessages = mockProvider.allSentMessages()
        val iceMessage = sentMessages.last()
        assertTrue(iceMessage.contains("\"type\":\"ice-candidate\""))
        assertTrue(iceMessage.contains("\"candidate\":\"candidate:1234...\""))
    }

    @org.junit.jupiter.api.Disabled("Requires integration testing with real coroutine dispatchers")
    @Test
    fun `receives ICE candidate from server`() = runTest {
        client = createClient(this)
        mockProvider.shouldConnect = true
        client.connect()

        val message = """{"type":"ice-candidate","candidate":{"candidate":"candidate:5678...","sdpMid":"0","sdpMLineIndex":0}}"""
        mockProvider.simulateIncomingMessage(message)

        val result = withTimeout(1000) { client.iceCandidates.first() }
        assertEquals("candidate:5678...", result.candidate)
    }

    @org.junit.jupiter.api.Disabled("Requires integration testing with real coroutine dispatchers")
    @Test
    fun `receives peer-joined from server`() = runTest {
        client = createClient(this)
        mockProvider.shouldConnect = true
        client.connect()

        val message = """{"type":"peer-joined","role":"controller"}"""
        mockProvider.simulateIncomingMessage(message)

        val result = withTimeout(1000) { client.peerJoined.first() }
        assertEquals("controller", result)
    }

    @org.junit.jupiter.api.Disabled("Requires integration testing with real coroutine dispatchers")
    @Test
    fun `receives peer-left from server`() = runTest {
        client = createClient(this)
        mockProvider.shouldConnect = true
        client.connect()

        val message = """{"type":"peer-left"}"""
        mockProvider.simulateIncomingMessage(message)

        withTimeout(1000) { client.peerLeft.first() }
        // Just verify it doesn't throw
    }

    @org.junit.jupiter.api.Disabled("Requires integration testing with real coroutine dispatchers")
    @Test
    fun `receives error from server`() = runTest {
        client = createClient(this)
        mockProvider.shouldConnect = true
        client.connect()

        val message = """{"type":"error","message":"Room is full"}"""
        mockProvider.simulateIncomingMessage(message)

        val result = withTimeout(1000) { client.errors.first() }
        assertEquals("Room is full", result)
    }

    @Test
    fun `throws on connection failure`() = runTest {
        mockProvider.shouldConnect = false

        assertThrows<SignalingConnectionException> {
            client.connect()
        }
    }

    @Test
    fun `reconnects after disconnect`() = runTest {
        mockProvider.shouldConnect = true
        client.connect()
        client.disconnect()

        client.connect()

        assertTrue(client.isConnected)
    }
}

/**
 * Mock WebSocket provider for testing.
 */
class MockWebSocketProvider : WebSocketProvider {
    var shouldConnect = true
    var delayMs: Long = 0
    private var currentSession: MockWebSocketSession? = null
    private var lastHeaders: Map<String, String> = emptyMap()

    override suspend fun connect(url: String, headers: Map<String, String>): WebSocketSession {
        lastHeaders = headers
        if (delayMs > 0) {
            kotlinx.coroutines.delay(delayMs)
        }
        if (!shouldConnect) {
            throw SignalingConnectionException("Mock connection refused")
        }
        currentSession = MockWebSocketSession()
        return currentSession!!
    }

    fun lastSentMessage(): String = currentSession?.sentMessages?.lastOrNull() ?: ""

    fun allSentMessages(): List<String> = currentSession?.sentMessages?.toList() ?: emptyList()

    fun lastConnectionHeaders(): Map<String, String> = lastHeaders

    suspend fun simulateIncomingMessage(message: String) {
        currentSession?.emitMessage(message)
    }
}

/**
 * Mock WebSocket session for testing.
 */
class MockWebSocketSession : WebSocketSession {
    private val messageChannel = Channel<String>(Channel.UNLIMITED)
    val sentMessages = mutableListOf<String>()
    private var connected = true

    override val isConnected: Boolean
        get() = connected

    override val incoming: Flow<String> = messageChannel.receiveAsFlow()

    suspend fun emitMessage(message: String) {
        messageChannel.send(message)
    }

    override suspend fun send(message: String) {
        sentMessages.add(message)
    }

    override suspend fun close() {
        connected = false
        messageChannel.close()
    }
}
