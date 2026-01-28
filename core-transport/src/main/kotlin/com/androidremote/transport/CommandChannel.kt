package com.androidremote.transport

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.util.UUID

/**
 * WebRTC data channel wrapper for sending commands and receiving acknowledgments.
 *
 * Commands are wrapped in an envelope with a unique ID for tracking responses.
 */
class CommandChannel(
    private val dataChannel: DataChannelInterface
) : DataChannelObserver {

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }
    private val _acknowledgments = MutableSharedFlow<CommandAck>(replay = 1)

    /**
     * Flow of command acknowledgments received from the device.
     */
    val acknowledgments: Flow<CommandAck> = _acknowledgments.asSharedFlow()

    /**
     * Whether the channel is ready to send commands.
     */
    val isOpen: Boolean
        get() = dataChannel.state == DataChannelState.OPEN

    init {
        dataChannel.setObserver(this)
    }

    /**
     * Send a command to the remote device.
     *
     * @return The command ID for tracking the acknowledgment
     */
    fun send(command: RemoteCommand): String {
        val envelope = CommandEnvelope(
            id = generateCommandId(),
            command = command
        )
        val jsonString = json.encodeToString(envelope)
        dataChannel.send(jsonString)
        return envelope.id
    }

    /**
     * Close the command channel.
     */
    fun close() {
        dataChannel.close()
    }

    // DataChannelObserver implementation

    override fun onStateChange(state: DataChannelState) {
        // Could emit state changes if needed
    }

    override fun onMessage(data: ByteArray) {
        // Binary messages not expected for commands
    }

    override fun onMessage(text: String) {
        try {
            val ack = json.decodeFromString<CommandAck>(text)
            _acknowledgments.tryEmit(ack)
        } catch (e: Exception) {
            // Ignore malformed messages
        }
    }

    private fun generateCommandId(): String {
        return UUID.randomUUID().toString()
    }
}
