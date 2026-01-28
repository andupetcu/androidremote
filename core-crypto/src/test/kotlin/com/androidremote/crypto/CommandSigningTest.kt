package com.androidremote.crypto

import com.google.common.truth.Truth.assertThat
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Test

/**
 * Tests for HMAC-based command signing.
 *
 * Commands are signed with a session key to prevent tampering and replay attacks.
 * These tests are written FIRST (TDD) - implementation follows.
 */
class CommandSigningTest {

    @Test
    fun `signs command with session key`() {
        val sessionKey = CryptoService.generateSessionKey()
        val command = Command(type = "TAP", payload = mapOf("x" to JsonPrimitive(0.5), "y" to JsonPrimitive(0.5)))

        val signedCommand = CommandSigner.sign(command, sessionKey)

        assertThat(signedCommand.hmac).isNotEmpty()
        assertThat(signedCommand.command).isEqualTo(command)
    }

    @Test
    fun `signed command includes timestamp`() {
        val sessionKey = CryptoService.generateSessionKey()
        val command = Command(type = "TAP", payload = mapOf("x" to JsonPrimitive(0.5), "y" to JsonPrimitive(0.5)))
        val beforeSign = System.currentTimeMillis()

        val signedCommand = CommandSigner.sign(command, sessionKey)

        val afterSign = System.currentTimeMillis()
        assertThat(signedCommand.timestamp).isAtLeast(beforeSign)
        assertThat(signedCommand.timestamp).isAtMost(afterSign)
    }

    @Test
    fun `verifies valid signed command`() {
        val sessionKey = CryptoService.generateSessionKey()
        val command = Command(type = "TAP", payload = mapOf("x" to JsonPrimitive(0.5), "y" to JsonPrimitive(0.5)))

        val signedCommand = CommandSigner.sign(command, sessionKey)
        val isValid = CommandSigner.verify(signedCommand, sessionKey)

        assertThat(isValid).isTrue()
    }

    @Test
    fun `rejects command with wrong session key`() {
        val sessionKey1 = CryptoService.generateSessionKey()
        val sessionKey2 = CryptoService.generateSessionKey()
        val command = Command(type = "TAP", payload = emptyMap())

        val signedCommand = CommandSigner.sign(command, sessionKey1)
        val isValid = CommandSigner.verify(signedCommand, sessionKey2)

        assertThat(isValid).isFalse()
    }

    @Test
    fun `rejects tampered command`() {
        val sessionKey = CryptoService.generateSessionKey()
        val command = Command(type = "TAP", payload = mapOf("x" to JsonPrimitive(0.5), "y" to JsonPrimitive(0.5)))

        val signedCommand = CommandSigner.sign(command, sessionKey)
        val tamperedCommand = signedCommand.copy(
            command = command.copy(type = "SWIPE")
        )
        val isValid = CommandSigner.verify(tamperedCommand, sessionKey)

        assertThat(isValid).isFalse()
    }

    @Test
    fun `rejects replay attack - old timestamp`() {
        val sessionKey = CryptoService.generateSessionKey()
        val command = Command(type = "TAP", payload = emptyMap())

        // Create a command with an old timestamp
        val oldTimestamp = System.currentTimeMillis() - 60_000 // 1 minute old
        val signedCommand = CommandSigner.signWithTimestamp(command, sessionKey, oldTimestamp)

        val isValid = CommandSigner.verify(signedCommand, sessionKey, maxAgeMs = 30_000)

        assertThat(isValid).isFalse()
    }

    @Test
    fun `accepts command within max age window`() {
        val sessionKey = CryptoService.generateSessionKey()
        val command = Command(type = "TAP", payload = emptyMap())

        val signedCommand = CommandSigner.sign(command, sessionKey)
        val isValid = CommandSigner.verify(signedCommand, sessionKey, maxAgeMs = 30_000)

        assertThat(isValid).isTrue()
    }

    @Test
    fun `rejects command with modified HMAC`() {
        val sessionKey = CryptoService.generateSessionKey()
        val command = Command(type = "TAP", payload = emptyMap())

        val signedCommand = CommandSigner.sign(command, sessionKey)
        val tamperedHmac = signedCommand.hmac.toByteArray()
        tamperedHmac[0] = (tamperedHmac[0].toInt() xor 0x01).toByte()

        val tamperedCommand = signedCommand.copy(hmac = String(tamperedHmac))
        val isValid = CommandSigner.verify(tamperedCommand, sessionKey)

        assertThat(isValid).isFalse()
    }

    @Test
    fun `generates different HMACs for different commands`() {
        val sessionKey = CryptoService.generateSessionKey()
        val command1 = Command(type = "TAP", payload = mapOf("x" to JsonPrimitive(0.1), "y" to JsonPrimitive(0.1)))
        val command2 = Command(type = "TAP", payload = mapOf("x" to JsonPrimitive(0.9), "y" to JsonPrimitive(0.9)))

        val signed1 = CommandSigner.sign(command1, sessionKey)
        val signed2 = CommandSigner.sign(command2, sessionKey)

        assertThat(signed1.hmac).isNotEqualTo(signed2.hmac)
    }
}
