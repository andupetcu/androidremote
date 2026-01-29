package com.androidremote.transport

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * Device-side data channel wrapper for receiving commands and sending acknowledgments.
 *
 * This is the counterpart to CommandChannel - while CommandChannel is used by the web client
 * to send commands, DeviceCommandChannel is used by the Android device to receive commands
 * and send back acknowledgments.
 */
class DeviceCommandChannel(
    private val dataChannel: DataChannelInterface
) : DataChannelObserver {

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }
    private val _commands = MutableSharedFlow<CommandEnvelope>(replay = 1)

    /**
     * Flow of commands received from the remote client.
     */
    val commands: Flow<CommandEnvelope> = _commands.asSharedFlow()

    /**
     * Whether the channel is ready to receive commands.
     */
    val isOpen: Boolean
        get() = dataChannel.state == DataChannelState.OPEN

    init {
        dataChannel.setObserver(this)
    }

    /**
     * Send an acknowledgment for a processed command.
     *
     * @param ack The acknowledgment to send
     * @return true if the message was queued successfully
     */
    fun sendAck(ack: CommandAck): Boolean {
        if (!isOpen) return false
        val jsonString = json.encodeToString(ack)
        return dataChannel.send(jsonString)
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
            val envelope = json.decodeFromString<CommandEnvelope>(text)
            _commands.tryEmit(envelope)
        } catch (e: Exception) {
            System.err.println("DeviceCommandChannel: Failed to deserialize command: ${e.message}, text=$text")
        }
    }
}
