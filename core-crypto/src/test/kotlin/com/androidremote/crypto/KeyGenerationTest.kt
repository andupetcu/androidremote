package com.androidremote.crypto

import com.google.common.truth.Truth.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertDoesNotThrow

/**
 * Tests for Ed25519 key generation.
 *
 * These tests are written FIRST (TDD) - implementation follows.
 */
class KeyGenerationTest {

    @Test
    fun `generates valid Ed25519 key pair`() {
        val keyPair = CryptoService.generateKeyPair()

        // Ed25519 public keys are 32 bytes
        assertThat(keyPair.publicKey).hasLength(32)
        // Ed25519 private keys are 64 bytes (includes public key)
        assertThat(keyPair.privateKey).hasLength(64)
    }

    @Test
    fun `key pairs are unique`() {
        val keyPair1 = CryptoService.generateKeyPair()
        val keyPair2 = CryptoService.generateKeyPair()

        assertThat(keyPair1.publicKey).isNotEqualTo(keyPair2.publicKey)
        assertThat(keyPair1.privateKey).isNotEqualTo(keyPair2.privateKey)
    }

    @Test
    fun `generates deterministic key pair from seed`() {
        val seed = ByteArray(32) { it.toByte() }

        val keyPair1 = CryptoService.generateKeyPairFromSeed(seed)
        val keyPair2 = CryptoService.generateKeyPairFromSeed(seed)

        assertThat(keyPair1.publicKey).isEqualTo(keyPair2.publicKey)
        assertThat(keyPair1.privateKey).isEqualTo(keyPair2.privateKey)
    }

    @Test
    fun `generates session key with correct length`() {
        val sessionKey = CryptoService.generateSessionKey()

        // Session keys are 32 bytes (256 bits)
        assertThat(sessionKey).hasLength(32)
    }

    @Test
    fun `session keys are unique`() {
        val key1 = CryptoService.generateSessionKey()
        val key2 = CryptoService.generateSessionKey()

        assertThat(key1).isNotEqualTo(key2)
    }

    @Test
    fun `derives session key from shared secret via X25519`() {
        val deviceKeys = CryptoService.generateKeyPair()
        val controllerKeys = CryptoService.generateKeyPair()

        // Both parties should derive the same session key
        // Note: deriveSessionKey takes X25519 public keys, not Ed25519 public keys
        val sessionKey1 = CryptoService.deriveSessionKey(
            deviceKeys.privateKey,
            controllerKeys.x25519PublicKey
        )
        val sessionKey2 = CryptoService.deriveSessionKey(
            controllerKeys.privateKey,
            deviceKeys.x25519PublicKey
        )

        assertThat(sessionKey1).isEqualTo(sessionKey2)
        assertThat(sessionKey1).hasLength(32)
    }

    @Test
    fun `key pair includes X25519 public key`() {
        val keyPair = CryptoService.generateKeyPair()

        assertThat(keyPair.x25519PublicKey).hasLength(32)
        // X25519 public key should be different from Ed25519 public key
        assertThat(keyPair.x25519PublicKey).isNotEqualTo(keyPair.publicKey)
    }
}
