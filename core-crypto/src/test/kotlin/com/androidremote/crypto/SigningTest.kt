package com.androidremote.crypto

import com.google.common.truth.Truth.assertThat
import org.junit.jupiter.api.Test

/**
 * Tests for Ed25519 message signing and verification.
 *
 * These tests are written FIRST (TDD) - implementation follows.
 */
class SigningTest {

    @Test
    fun `signs and verifies message`() {
        val keyPair = CryptoService.generateKeyPair()
        val message = "test message".toByteArray()

        val signature = CryptoService.sign(message, keyPair.privateKey)
        val isValid = CryptoService.verify(message, signature, keyPair.publicKey)

        assertThat(isValid).isTrue()
    }

    @Test
    fun `signature has correct length`() {
        val keyPair = CryptoService.generateKeyPair()
        val message = "test message".toByteArray()

        val signature = CryptoService.sign(message, keyPair.privateKey)

        // Ed25519 signatures are 64 bytes
        assertThat(signature).hasLength(64)
    }

    @Test
    fun `rejects tampered message`() {
        val keyPair = CryptoService.generateKeyPair()
        val message = "test message".toByteArray()
        val tamperedMessage = "tampered message".toByteArray()

        val signature = CryptoService.sign(message, keyPair.privateKey)
        val isValid = CryptoService.verify(tamperedMessage, signature, keyPair.publicKey)

        assertThat(isValid).isFalse()
    }

    @Test
    fun `rejects wrong public key`() {
        val keyPair1 = CryptoService.generateKeyPair()
        val keyPair2 = CryptoService.generateKeyPair()
        val message = "test message".toByteArray()

        val signature = CryptoService.sign(message, keyPair1.privateKey)
        val isValid = CryptoService.verify(message, signature, keyPair2.publicKey)

        assertThat(isValid).isFalse()
    }

    @Test
    fun `rejects modified signature`() {
        val keyPair = CryptoService.generateKeyPair()
        val message = "test message".toByteArray()

        val signature = CryptoService.sign(message, keyPair.privateKey)
        // Flip a bit in the signature
        val modifiedSignature = signature.copyOf()
        modifiedSignature[0] = (modifiedSignature[0].toInt() xor 0x01).toByte()

        val isValid = CryptoService.verify(message, modifiedSignature, keyPair.publicKey)

        assertThat(isValid).isFalse()
    }

    @Test
    fun `signs empty message`() {
        val keyPair = CryptoService.generateKeyPair()
        val emptyMessage = ByteArray(0)

        val signature = CryptoService.sign(emptyMessage, keyPair.privateKey)
        val isValid = CryptoService.verify(emptyMessage, signature, keyPair.publicKey)

        assertThat(isValid).isTrue()
    }

    @Test
    fun `signs large message`() {
        val keyPair = CryptoService.generateKeyPair()
        val largeMessage = ByteArray(1024 * 1024) { it.toByte() } // 1 MB

        val signature = CryptoService.sign(largeMessage, keyPair.privateKey)
        val isValid = CryptoService.verify(largeMessage, signature, keyPair.publicKey)

        assertThat(isValid).isTrue()
    }
}
