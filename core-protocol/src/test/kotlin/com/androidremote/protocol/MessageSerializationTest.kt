package com.androidremote.protocol

import com.google.common.truth.Truth.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

/**
 * Tests for message serialization/deserialization.
 *
 * The protocol uses JSON for command transmission between web UI and device.
 * Commands must be serialized consistently for signing/verification.
 *
 * These tests are written FIRST (TDD) - implementation follows.
 */
class MessageSerializationTest {

    @Test
    fun `serializes tap command`() {
        val command = TapCommand(x = 0.5f, y = 0.5f)

        val json = MessageSerializer.serialize(command)

        assertThat(json).contains("\"type\":\"TAP\"")
        assertThat(json).contains("\"x\":0.5")
        assertThat(json).contains("\"y\":0.5")
    }

    @Test
    fun `deserializes tap command`() {
        val json = """{"type":"TAP","x":0.5,"y":0.5}"""

        val command = MessageSerializer.deserialize(json)

        assertThat(command).isInstanceOf(TapCommand::class.java)
        val tap = command as TapCommand
        assertThat(tap.x).isEqualTo(0.5f)
        assertThat(tap.y).isEqualTo(0.5f)
    }

    @Test
    fun `serializes long press command`() {
        val command = LongPressCommand(x = 0.3f, y = 0.7f, durationMs = 800)

        val json = MessageSerializer.serialize(command)

        assertThat(json).contains("\"type\":\"LONG_PRESS\"")
        assertThat(json).contains("\"x\":0.3")
        assertThat(json).contains("\"y\":0.7")
        assertThat(json).contains("\"durationMs\":800")
    }

    @Test
    fun `deserializes long press command`() {
        val json = """{"type":"LONG_PRESS","x":0.3,"y":0.7,"durationMs":800}"""

        val command = MessageSerializer.deserialize(json)

        assertThat(command).isInstanceOf(LongPressCommand::class.java)
        val longPress = command as LongPressCommand
        assertThat(longPress.x).isEqualTo(0.3f)
        assertThat(longPress.y).isEqualTo(0.7f)
        assertThat(longPress.durationMs).isEqualTo(800)
    }

    @Test
    fun `serializes swipe command`() {
        val command = SwipeCommand(
            startX = 0.5f, startY = 0.8f,
            endX = 0.5f, endY = 0.2f,
            durationMs = 300
        )

        val json = MessageSerializer.serialize(command)

        assertThat(json).contains("\"type\":\"SWIPE\"")
        assertThat(json).contains("\"startX\":0.5")
        assertThat(json).contains("\"startY\":0.8")
        assertThat(json).contains("\"endX\":0.5")
        assertThat(json).contains("\"endY\":0.2")
        assertThat(json).contains("\"durationMs\":300")
    }

    @Test
    fun `deserializes swipe command`() {
        val json = """{"type":"SWIPE","startX":0.5,"startY":0.8,"endX":0.5,"endY":0.2,"durationMs":300}"""

        val command = MessageSerializer.deserialize(json)

        assertThat(command).isInstanceOf(SwipeCommand::class.java)
        val swipe = command as SwipeCommand
        assertThat(swipe.startX).isEqualTo(0.5f)
        assertThat(swipe.startY).isEqualTo(0.8f)
        assertThat(swipe.endX).isEqualTo(0.5f)
        assertThat(swipe.endY).isEqualTo(0.2f)
        assertThat(swipe.durationMs).isEqualTo(300)
    }

    @Test
    fun `serializes pinch command`() {
        val command = PinchCommand(
            centerX = 0.5f, centerY = 0.5f,
            startDistance = 0.1f, endDistance = 0.4f,
            durationMs = 400
        )

        val json = MessageSerializer.serialize(command)

        assertThat(json).contains("\"type\":\"PINCH\"")
        assertThat(json).contains("\"centerX\":0.5")
        assertThat(json).contains("\"centerY\":0.5")
    }

    @Test
    fun `deserializes pinch command`() {
        val json = """{"type":"PINCH","centerX":0.5,"centerY":0.5,"startDistance":0.1,"endDistance":0.4,"durationMs":400}"""

        val command = MessageSerializer.deserialize(json)

        assertThat(command).isInstanceOf(PinchCommand::class.java)
        val pinch = command as PinchCommand
        assertThat(pinch.centerX).isEqualTo(0.5f)
        assertThat(pinch.startDistance).isEqualTo(0.1f)
        assertThat(pinch.endDistance).isEqualTo(0.4f)
    }

    @Test
    fun `serializes key event command`() {
        val command = KeyEventCommand(keyCode = KeyCode.BACK)

        val json = MessageSerializer.serialize(command)

        assertThat(json).contains("\"type\":\"KEY_EVENT\"")
        assertThat(json).contains("\"keyCode\":\"BACK\"")
    }

    @Test
    fun `deserializes key event command`() {
        val json = """{"type":"KEY_EVENT","keyCode":"BACK"}"""

        val command = MessageSerializer.deserialize(json)

        assertThat(command).isInstanceOf(KeyEventCommand::class.java)
        val keyEvent = command as KeyEventCommand
        assertThat(keyEvent.keyCode).isEqualTo(KeyCode.BACK)
    }

    @Test
    fun `serializes text input command`() {
        val command = TextInputCommand(text = "Hello, World!")

        val json = MessageSerializer.serialize(command)

        assertThat(json).contains("\"type\":\"TEXT_INPUT\"")
        assertThat(json).contains("\"text\":\"Hello, World!\"")
    }

    @Test
    fun `deserializes text input command`() {
        val json = """{"type":"TEXT_INPUT","text":"Hello, World!"}"""

        val command = MessageSerializer.deserialize(json)

        assertThat(command).isInstanceOf(TextInputCommand::class.java)
        val textInput = command as TextInputCommand
        assertThat(textInput.text).isEqualTo("Hello, World!")
    }

    @Test
    fun `rejects malformed message - invalid JSON`() {
        val malformed = """{"type":"TAP", invalid}"""

        assertThrows<MessageParseException> {
            MessageSerializer.deserialize(malformed)
        }
    }

    @Test
    fun `rejects malformed message - wrong type for field`() {
        val malformed = """{"type":"TAP","x":"not-a-number","y":0.5}"""

        assertThrows<MessageParseException> {
            MessageSerializer.deserialize(malformed)
        }
    }

    @Test
    fun `rejects unknown command type`() {
        val unknown = """{"type":"UNKNOWN_COMMAND","data":"test"}"""

        assertThrows<MessageParseException> {
            MessageSerializer.deserialize(unknown)
        }
    }

    @Test
    fun `rejects missing required field`() {
        val incomplete = """{"type":"TAP","x":0.5}""" // Missing y

        assertThrows<MessageParseException> {
            MessageSerializer.deserialize(incomplete)
        }
    }

    @Test
    fun `handles special characters in text input`() {
        val command = TextInputCommand(text = "Hello \"World\" with\nnewline")

        val json = MessageSerializer.serialize(command)
        val deserialized = MessageSerializer.deserialize(json) as TextInputCommand

        assertThat(deserialized.text).isEqualTo("Hello \"World\" with\nnewline")
    }

    @Test
    fun `handles unicode in text input`() {
        val command = TextInputCommand(text = "Hello 世界 🌍")

        val json = MessageSerializer.serialize(command)
        val deserialized = MessageSerializer.deserialize(json) as TextInputCommand

        assertThat(deserialized.text).isEqualTo("Hello 世界 🌍")
    }

    @Test
    fun `serialization is deterministic for signing`() {
        val command = TapCommand(x = 0.5f, y = 0.5f)

        val json1 = MessageSerializer.serialize(command)
        val json2 = MessageSerializer.serialize(command)

        assertThat(json1).isEqualTo(json2)
    }

    @Test
    fun `deserializes all supported key codes`() {
        val keyCodes = listOf(
            KeyCode.BACK,
            KeyCode.HOME,
            KeyCode.RECENT_APPS,
            KeyCode.VOLUME_UP,
            KeyCode.VOLUME_DOWN,
            KeyCode.POWER
        )

        for (keyCode in keyCodes) {
            val json = """{"type":"KEY_EVENT","keyCode":"${keyCode.name}"}"""
            val command = MessageSerializer.deserialize(json) as KeyEventCommand
            assertThat(command.keyCode).isEqualTo(keyCode)
        }
    }
}
