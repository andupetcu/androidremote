package com.androidremote.transport

import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * Control messages (contract C9) that travel on the `commands` channel next to command envelopes.
 */
sealed class ControlMessage {
    /** The browser asks for a sync frame after a decode error or a gap. */
    object RequestKeyFrame : ControlMessage()
}

/**
 * Device-side data channel wrapper for receiving commands and sending acknowledgments.
 *
 * This is the counterpart to CommandChannel - while CommandChannel is used by the web client
 * to send commands, DeviceCommandChannel is used by the Android device to receive commands
 * and send back acknowledgments.
 *
 * Incoming messages are buffered in a [Channel] so a burst of input (or a slow handler) never
 * drops a command, and a single undecodable message never affects the next one.
 */
class DeviceCommandChannel(
    private val dataChannel: DataChannelInterface
) : DataChannelObserver {

    companion object {
        /** Messages buffered before the consumer runs. A viewer cannot realistically exceed this. */
        const val COMMAND_BUFFER = 4096
    }

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }
    private val _commands = Channel<CommandEnvelope>(COMMAND_BUFFER)
    private val _controlMessages = Channel<ControlMessage>(256)
    private val _state = MutableStateFlow(dataChannel.state)

    /**
     * Flow of commands received from the remote client, in arrival order.
     * Single consumer: each command is delivered once.
     */
    val commands: Flow<CommandEnvelope> = _commands.receiveAsFlow()

    /**
     * Flow of control messages (for example REQUEST_KEYFRAME).
     */
    val controlMessages: Flow<ControlMessage> = _controlMessages.receiveAsFlow()

    /**
     * State of the underlying data channel.
     */
    val state: StateFlow<DataChannelState> = _state.asStateFlow()

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
     * Tell the browser the current capture geometry (contract C9).
     */
    fun sendScreenInfo(width: Int, height: Int, rotation: Int): Boolean = sendControl(
        buildJsonObject {
            put("type", "SCREEN_INFO")
            put("width", width)
            put("height", height)
            put("rotation", rotation)
        }
    )

    /**
     * Tell the browser why capture could not start (contract C8).
     */
    fun sendCaptureFailed(reason: String): Boolean = sendControl(
        buildJsonObject {
            put("type", "CAPTURE_FAILED")
            put("reason", reason)
        }
    )

    private fun sendControl(message: JsonObject): Boolean {
        if (!isOpen) return false
        return dataChannel.send(message.toString())
    }

    /**
     * Close the command channel.
     */
    fun close() {
        _commands.close()
        _controlMessages.close()
        dataChannel.close()
    }

    // DataChannelObserver implementation

    override fun onStateChange(state: DataChannelState) {
        _state.value = state
    }

    override fun onMessage(data: ByteArray) {
        // Binary messages not expected for commands
    }

    override fun onMessage(text: String) {
        try {
            val obj = json.parseToJsonElement(text).jsonObject
            val type = (obj["type"] as? JsonPrimitive)?.content
            if (type == "REQUEST_KEYFRAME") {
                _controlMessages.trySend(ControlMessage.RequestKeyFrame)
                return
            }
            val envelope = json.decodeFromString<CommandEnvelope>(text)
            if (_commands.trySend(envelope).isFailure) {
                System.err.println("DeviceCommandChannel: command buffer full or closed, dropped id=${envelope.id}")
            }
        } catch (e: Exception) {
            // Never log the message text: TYPE_TEXT carries what the viewer types, including passwords.
            System.err.println("DeviceCommandChannel: undecodable message (length=${text.length}, ${e::class.simpleName})")
        }
    }
}
