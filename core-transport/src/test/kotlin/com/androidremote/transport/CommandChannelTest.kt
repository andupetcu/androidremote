package com.androidremote.transport

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class CommandChannelTest {

    private lateinit var mockDataChannel: MockDataChannel
    private lateinit var commandChannel: CommandChannel
    private val json = Json { ignoreUnknownKeys = true }

    @BeforeEach
    fun setup() {
        mockDataChannel = MockDataChannel("commands")
        commandChannel = CommandChannel(mockDataChannel)
    }

    @Test
    fun `sends tap command`() = runTest {
        val command = RemoteCommand.Tap(x = 0.5f, y = 0.5f)

        commandChannel.send(command)

        val sent = mockDataChannel.lastSentText()
        assertTrue(sent.contains("\"type\":\"TAP\""))
        assertTrue(sent.contains("\"x\":0.5"))
        assertTrue(sent.contains("\"y\":0.5"))
    }

    @Test
    fun `sends swipe command`() = runTest {
        val command = RemoteCommand.Swipe(
            startX = 0.2f,
            startY = 0.8f,
            endX = 0.2f,
            endY = 0.2f,
            durationMs = 300
        )

        commandChannel.send(command)

        val sent = mockDataChannel.lastSentText()
        assertTrue(sent.contains("\"type\":\"SWIPE\""))
        assertTrue(sent.contains("\"durationMs\":300"))
    }

    @Test
    fun `sends type text command`() = runTest {
        val command = RemoteCommand.TypeText(text = "Hello, World!")

        commandChannel.send(command)

        val sent = mockDataChannel.lastSentText()
        assertTrue(sent.contains("\"type\":\"TYPE_TEXT\""))
        assertTrue(sent.contains("\"text\":\"Hello, World!\""))
    }

    @Test
    fun `sends key press command`() = runTest {
        val command = RemoteCommand.KeyPress(keyCode = 4) // KEYCODE_BACK

        commandChannel.send(command)

        val sent = mockDataChannel.lastSentText()
        assertTrue(sent.contains("\"type\":\"KEY_PRESS\""))
        assertTrue(sent.contains("\"keyCode\":4"))
    }

    @Test
    fun `sends long press command`() = runTest {
        val command = RemoteCommand.LongPress(x = 0.5f, y = 0.5f, durationMs = 500)

        commandChannel.send(command)

        val sent = mockDataChannel.lastSentText()
        assertTrue(sent.contains("\"type\":\"LONG_PRESS\""))
        assertTrue(sent.contains("\"durationMs\":500"))
    }

    @Test
    fun `receives command acknowledgment`() = runTest {
        val ack = CommandAck(commandId = "cmd-123", success = true)
        mockDataChannel.simulateIncomingText(json.encodeToString(ack))

        val received = withTimeout(1000) {
            commandChannel.acknowledgments.first()
        }

        assertEquals("cmd-123", received.commandId)
        assertTrue(received.success)
    }

    @Test
    fun `receives command error`() = runTest {
        val ack = CommandAck(
            commandId = "cmd-456",
            success = false,
            errorMessage = "Touch injection failed"
        )
        mockDataChannel.simulateIncomingText(json.encodeToString(ack))

        val received = withTimeout(1000) {
            commandChannel.acknowledgments.first()
        }

        assertEquals("cmd-456", received.commandId)
        assertEquals(false, received.success)
        assertEquals("Touch injection failed", received.errorMessage)
    }

    @Test
    fun `generates unique command IDs`() = runTest {
        val command1 = RemoteCommand.Tap(x = 0.1f, y = 0.1f)
        val command2 = RemoteCommand.Tap(x = 0.2f, y = 0.2f)

        commandChannel.send(command1)
        commandChannel.send(command2)

        val messages = mockDataChannel.sentTextMessages
        assertEquals(2, messages.size)

        // Each command should have a unique ID
        val id1 = json.decodeFromString<CommandEnvelope>(messages[0]).id
        val id2 = json.decodeFromString<CommandEnvelope>(messages[1]).id
        assertTrue(id1 != id2)
    }

    @Test
    fun `closes underlying data channel`() {
        commandChannel.close()

        assertTrue(mockDataChannel.isClosed)
    }
}

/**
 * Mock data channel for testing command serialization.
 */
class MockDataChannel(override val label: String) : DataChannelInterface {
    override val state: DataChannelState = DataChannelState.OPEN

    val sentTextMessages = mutableListOf<String>()
    val sentBinaryMessages = mutableListOf<ByteArray>()
    var isClosed = false
    private var observer: DataChannelObserver? = null

    override fun send(data: ByteArray): Boolean {
        sentBinaryMessages.add(data)
        return true
    }

    override fun send(text: String): Boolean {
        sentTextMessages.add(text)
        return true
    }

    override fun close() {
        isClosed = true
    }

    override fun setObserver(observer: DataChannelObserver) {
        this.observer = observer
    }

    fun lastSentText(): String = sentTextMessages.lastOrNull() ?: ""

    fun simulateIncomingText(text: String) {
        observer?.onMessage(text)
    }

    fun simulateIncomingBinary(data: ByteArray) {
        observer?.onMessage(data)
    }
}
