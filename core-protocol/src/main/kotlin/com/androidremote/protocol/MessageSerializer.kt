package com.androidremote.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Exception thrown when message parsing fails.
 */
class MessageParseException(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * Serializes and deserializes remote control commands to/from JSON.
 *
 * Uses kotlinx.serialization with a custom discriminator for command type.
 * Ensures deterministic output for HMAC signing.
 */
object MessageSerializer {

    private val json = Json {
        encodeDefaults = true
        ignoreUnknownKeys = false
        isLenient = false
        prettyPrint = false
    }

    /**
     * Serializes a command to JSON string.
     *
     * @param command The command to serialize
     * @return JSON string representation
     */
    fun serialize(command: RemoteCommand): String {
        return when (command) {
            is TapCommand -> json.encodeToString(TapCommand.serializer(), command)
            is LongPressCommand -> json.encodeToString(LongPressCommand.serializer(), command)
            is SwipeCommand -> json.encodeToString(SwipeCommand.serializer(), command)
            is PinchCommand -> json.encodeToString(PinchCommand.serializer(), command)
            is KeyEventCommand -> json.encodeToString(KeyEventCommand.serializer(), command)
            is TextInputCommand -> json.encodeToString(TextInputCommand.serializer(), command)
        }
    }

    /**
     * Deserializes a JSON string to a command.
     *
     * @param jsonString The JSON to deserialize
     * @return The parsed command
     * @throws MessageParseException if parsing fails
     */
    fun deserialize(jsonString: String): RemoteCommand {
        try {
            // First parse to get the type field
            val jsonObject = json.parseToJsonElement(jsonString) as? JsonObject
                ?: throw MessageParseException("Invalid JSON: not an object")

            val typeElement = jsonObject["type"]
                ?: throw MessageParseException("Missing 'type' field")

            val type = typeElement.jsonPrimitive.content

            return when (type) {
                "TAP" -> json.decodeFromString(TapCommand.serializer(), jsonString)
                "LONG_PRESS" -> json.decodeFromString(LongPressCommand.serializer(), jsonString)
                "SWIPE" -> json.decodeFromString(SwipeCommand.serializer(), jsonString)
                "PINCH" -> json.decodeFromString(PinchCommand.serializer(), jsonString)
                "KEY_EVENT" -> json.decodeFromString(KeyEventCommand.serializer(), jsonString)
                "TEXT_INPUT" -> json.decodeFromString(TextInputCommand.serializer(), jsonString)
                else -> throw MessageParseException("Unknown command type: $type")
            }
        } catch (e: MessageParseException) {
            throw e
        } catch (e: kotlinx.serialization.SerializationException) {
            throw MessageParseException("Failed to parse message: ${e.message}", e)
        } catch (e: IllegalArgumentException) {
            throw MessageParseException("Invalid field value: ${e.message}", e)
        } catch (e: Exception) {
            throw MessageParseException("Unexpected error parsing message: ${e.message}", e)
        }
    }
}
