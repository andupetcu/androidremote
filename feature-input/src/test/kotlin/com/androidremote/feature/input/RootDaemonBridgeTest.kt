package com.androidremote.feature.input

import com.androidremote.crypto.CommandSigner
import com.androidremote.crypto.SignedCommand
import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.io.IOException
import java.security.SecureRandom

/**
 * Tests for RootDaemonBridge - the Kotlin side of the daemon communication.
 *
 * These tests use a mock socket to verify behavior without requiring
 * the actual Rust daemon to be running.
 */
class RootDaemonBridgeTest {

    private lateinit var mockSocket: MockDaemonSocket
    private lateinit var bridge: RootDaemonBridge
    private lateinit var sessionKey: ByteArray

    @BeforeEach
    fun setup() {
        mockSocket = MockDaemonSocket()
        sessionKey = generateSessionKey()
        bridge = RootDaemonBridge(
            socketFactory = { mockSocket },
            sessionKey = sessionKey
        )
    }

    private fun generateSessionKey(): ByteArray {
        val key = ByteArray(32)
        SecureRandom().nextBytes(key)
        return key
    }

    @Nested
    @DisplayName("Connection Management")
    inner class ConnectionTests {

        @Test
        fun `connects to daemon socket`() = runBlocking {
            bridge.connect()

            assertThat(bridge.isConnected).isTrue()
            assertThat(mockSocket.isConnected()).isTrue()
        }

        @Test
        fun `is not connected initially`() {
            assertThat(bridge.isConnected).isFalse()
        }

        @Test
        fun `disconnect closes socket`() = runBlocking {
            bridge.connect()

            bridge.disconnect()

            assertThat(bridge.isConnected).isFalse()
            assertThat(mockSocket.isClosed).isTrue()
        }

        @Test
        fun `throws when connection fails`(): Unit = runBlocking {
            mockSocket.shouldFailConnect = true

            assertThrows<DaemonConnectionException> {
                runBlocking { bridge.connect() }
            }
        }

        @Test
        fun `reconnect creates new connection`() = runBlocking {
            bridge.connect()
            bridge.disconnect()

            // Create a new mock for the second connection
            val newMock = MockDaemonSocket()
            bridge = RootDaemonBridge(
                socketFactory = { newMock },
                sessionKey = sessionKey
            )
            bridge.connect()

            assertThat(bridge.isConnected).isTrue()
            assertThat(newMock.isConnected()).isTrue()
        }
    }

    @Nested
    @DisplayName("Command Sending")
    inner class CommandSendingTests {

        @BeforeEach
        fun connectBridge(): Unit = runBlocking {
            bridge.connect()
        }

        @Test
        fun `sends tap command`() = runBlocking {
            val command = DaemonCommand.Tap(x = 100, y = 200)

            bridge.sendCommand(command)

            val sent = mockSocket.getSentCommands().first()
            assertThat(sent.command.type).isEqualTo("TAP")
            assertThat(sent.command.payload["x"]).isEqualTo(JsonPrimitive(100))
            assertThat(sent.command.payload["y"]).isEqualTo(JsonPrimitive(200))
        }

        @Test
        fun `sends long press command`() = runBlocking {
            val command = DaemonCommand.LongPress(x = 150, y = 250, durationMs = 500)

            bridge.sendCommand(command)

            val sent = mockSocket.getSentCommands().first()
            assertThat(sent.command.type).isEqualTo("LONG_PRESS")
            assertThat(sent.command.payload["x"]).isEqualTo(JsonPrimitive(150))
            assertThat(sent.command.payload["y"]).isEqualTo(JsonPrimitive(250))
            assertThat(sent.command.payload["duration_ms"]).isEqualTo(JsonPrimitive(500))
        }

        @Test
        fun `sends swipe command`() = runBlocking {
            val command = DaemonCommand.Swipe(
                startX = 100, startY = 200,
                endX = 300, endY = 400,
                durationMs = 250
            )

            bridge.sendCommand(command)

            val sent = mockSocket.getSentCommands().first()
            assertThat(sent.command.type).isEqualTo("SWIPE")
            assertThat(sent.command.payload["start_x"]).isEqualTo(JsonPrimitive(100))
            assertThat(sent.command.payload["start_y"]).isEqualTo(JsonPrimitive(200))
            assertThat(sent.command.payload["end_x"]).isEqualTo(JsonPrimitive(300))
            assertThat(sent.command.payload["end_y"]).isEqualTo(JsonPrimitive(400))
            assertThat(sent.command.payload["duration_ms"]).isEqualTo(JsonPrimitive(250))
        }

        @Test
        fun `sends key press command`() = runBlocking {
            val command = DaemonCommand.Key(code = 4) // BACK key

            bridge.sendCommand(command)

            val sent = mockSocket.getSentCommands().first()
            assertThat(sent.command.type).isEqualTo("KEY")
            assertThat(sent.command.payload["code"]).isEqualTo(JsonPrimitive(4))
        }

        @Test
        fun `sends text input command`() = runBlocking {
            val command = DaemonCommand.Text(text = "Hello World")

            bridge.sendCommand(command)

            val sent = mockSocket.getSentCommands().first()
            assertThat(sent.command.type).isEqualTo("TEXT")
            assertThat(sent.command.payload["text"]).isEqualTo(JsonPrimitive("Hello World"))
        }

        @Test
        fun `commands are signed with session key`() = runBlocking {
            val command = DaemonCommand.Tap(x = 100, y = 200)

            bridge.sendCommand(command)

            val sent = mockSocket.getSentCommands().first()
            assertThat(sent.hmac).isNotNull()
            assertThat(sent.hmac).isNotEmpty()
            assertThat(sent.timestamp).isGreaterThan(0L)
        }

        @Test
        fun `signed commands can be verified`() = runBlocking {
            val command = DaemonCommand.Tap(x = 100, y = 200)

            bridge.sendCommand(command)

            val sent = mockSocket.getSentCommands().first()
            // Convert to SignedCommand for verification
            val signedCommand = SignedCommand(
                command = sent.command,
                hmac = sent.hmac,
                timestamp = sent.timestamp
            )
            assertThat(CommandSigner.verify(signedCommand, sessionKey)).isTrue()
        }

        @Test
        fun `multiple commands can be sent`() = runBlocking {
            bridge.sendCommand(DaemonCommand.Tap(x = 100, y = 200))
            bridge.sendCommand(DaemonCommand.Tap(x = 300, y = 400))
            bridge.sendCommand(DaemonCommand.Key(code = 4))

            assertThat(mockSocket.getSentCommands()).hasSize(3)
        }
    }

    @Nested
    @DisplayName("Error Handling")
    inner class ErrorHandlingTests {

        @Test
        fun `throws when sending command without connection`() {
            val command = DaemonCommand.Tap(x = 100, y = 200)

            assertThrows<DaemonDisconnectedException> {
                runBlocking { bridge.sendCommand(command) }
            }
        }

        @Test
        fun `throws when daemon disconnects`(): Unit = runBlocking {
            bridge.connect()
            mockSocket.simulateDisconnect()

            assertThrows<DaemonDisconnectedException> {
                runBlocking { bridge.sendCommand(DaemonCommand.Tap(x = 100, y = 200)) }
            }
        }

        @Test
        fun `handles daemon error response`(): Unit = runBlocking {
            bridge.connect()
            mockSocket.nextResponse = DaemonResponse.Error("Invalid signature")

            assertThrows<DaemonCommandException> {
                runBlocking { bridge.sendCommand(DaemonCommand.Tap(x = 100, y = 200)) }
            }
        }

        @Test
        fun `reports disconnected state after daemon crash`() = runBlocking {
            bridge.connect()
            assertThat(bridge.isConnected).isTrue()

            mockSocket.simulateDisconnect()

            // Check that we detect the disconnection
            assertThat(bridge.isConnected).isFalse()
        }

        @Test
        fun `write failure marks bridge as disconnected`() = runBlocking {
            bridge.connect()
            mockSocket.shouldFailWrite = true

            try {
                bridge.sendCommand(DaemonCommand.Tap(x = 100, y = 200))
            } catch (e: Exception) {
                // Expected
            }

            assertThat(bridge.isConnected).isFalse()
        }
    }

    @Nested
    @DisplayName("Session Key Management")
    inner class SessionKeyTests {

        @Test
        fun `requires session key to be set`() {
            assertThrows<IllegalArgumentException> {
                RootDaemonBridge(
                    socketFactory = { mockSocket },
                    sessionKey = ByteArray(0)
                )
            }
        }

        @Test
        fun `requires 32-byte session key`() {
            assertThrows<IllegalArgumentException> {
                RootDaemonBridge(
                    socketFactory = { mockSocket },
                    sessionKey = ByteArray(16) // Too short
                )
            }
        }

        @Test
        fun `can update session key`() = runBlocking {
            bridge.connect()
            val oldKey = sessionKey
            val newKey = generateSessionKey()

            bridge.updateSessionKey(newKey)
            bridge.sendCommand(DaemonCommand.Tap(x = 100, y = 200))

            val sent = mockSocket.getSentCommands().first()
            val signedCommand = SignedCommand(
                command = sent.command,
                hmac = sent.hmac,
                timestamp = sent.timestamp
            )
            // Should be verifiable with new key
            assertThat(CommandSigner.verify(signedCommand, newKey)).isTrue()
            // Should NOT be verifiable with old key
            assertThat(CommandSigner.verify(signedCommand, oldKey)).isFalse()
        }
    }

    @Nested
    @DisplayName("Command Response Handling")
    inner class ResponseTests {

        @BeforeEach
        fun connectBridge(): Unit = runBlocking {
            bridge.connect()
        }

        @Test
        fun `successful command returns success`() = runBlocking {
            mockSocket.nextResponse = DaemonResponse.Ok

            val result = bridge.sendCommand(DaemonCommand.Tap(x = 100, y = 200))

            assertThat(result).isEqualTo(CommandResult.Success)
        }

        @Test
        fun `daemon error throws exception with message`(): Unit = runBlocking {
            mockSocket.nextResponse = DaemonResponse.Error("Coordinates out of bounds")

            val result = runCatching {
                runBlocking { bridge.sendCommand(DaemonCommand.Tap(x = 9999, y = 9999)) }
            }

            assertThat(result.isFailure).isTrue()
            val exception = result.exceptionOrNull() as DaemonCommandException
            assertThat(exception.message).contains("Coordinates out of bounds")
        }
    }

    @Nested
    @DisplayName("Nonce Generation")
    inner class NonceTests {

        @BeforeEach
        fun connectBridge(): Unit = runBlocking {
            bridge.connect()
        }

        @Test
        fun `each command has unique nonce`() = runBlocking {
            repeat(10) {
                bridge.sendCommand(DaemonCommand.Tap(x = 100, y = 200))
            }

            val nonces = mockSocket.getSentCommands().map { it.nonce }
            assertThat(nonces.distinct()).hasSize(nonces.size)
        }

        @Test
        fun `nonces are non-empty strings`() = runBlocking {
            bridge.sendCommand(DaemonCommand.Tap(x = 100, y = 200))

            val sent = mockSocket.getSentCommands().first()
            assertThat(sent.nonce).isNotEmpty()
        }
    }
}

/**
 * Mock daemon socket for testing without actual IPC.
 */
class MockDaemonSocket : DaemonSocket {
    private var _connected = false
    var isClosed = false
        private set
    var shouldFailConnect = false
    var shouldFailWrite = false
    var nextResponse: DaemonResponse = DaemonResponse.Ok

    private val sentCommands = mutableListOf<SignedDaemonCommand>()
    private var disconnected = false

    override suspend fun connect(path: String) {
        if (shouldFailConnect) {
            throw IOException("Connection refused")
        }
        _connected = true
        isClosed = false
        disconnected = false
    }

    override suspend fun write(command: SignedDaemonCommand) {
        if (disconnected || shouldFailWrite) {
            throw IOException("Socket disconnected")
        }
        sentCommands.add(command)
    }

    override suspend fun read(): DaemonResponse {
        if (disconnected) {
            throw IOException("Socket disconnected")
        }
        return nextResponse
    }

    override fun close() {
        _connected = false
        isClosed = true
    }

    override fun isConnected(): Boolean = _connected && !disconnected

    fun simulateDisconnect() {
        disconnected = true
        _connected = false
    }

    fun getSentCommands(): List<SignedDaemonCommand> = sentCommands.toList()
}
