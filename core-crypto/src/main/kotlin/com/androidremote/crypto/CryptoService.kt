package com.androidremote.crypto

import org.bouncycastle.crypto.agreement.X25519Agreement
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.digests.SHA512Digest
import org.bouncycastle.crypto.generators.Ed25519KeyPairGenerator
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.params.Ed25519KeyGenerationParameters
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import java.security.SecureRandom

/**
 * Core cryptographic operations using Ed25519 and X25519.
 *
 * This service provides:
 * - Ed25519 key pair generation for device identity and signing
 * - Ed25519 message signing and verification
 * - X25519 key exchange for session key derivation (with key conversion)
 * - HKDF for deriving session keys from shared secrets
 *
 * Key format:
 * - Public keys: 32 bytes (Ed25519 or X25519 depending on use)
 * - Private keys: 64 bytes (32-byte seed + 32-byte public key for Ed25519)
 *
 * The private key contains both the seed and derived public key to allow
 * efficient operations without recomputation.
 *
 * Uses BouncyCastle for cryptographic primitives.
 */
object CryptoService {

    private val secureRandom = SecureRandom()

    // HKDF info string for session key derivation
    private val SESSION_KEY_INFO = "android-remote-session-key".toByteArray()

    /**
     * Generates a new Ed25519 key pair with corresponding X25519 key for key exchange.
     *
     * @return A new key pair with Ed25519 keys for signing and X25519 key for key exchange
     */
    fun generateKeyPair(): KeyPair {
        val generator = Ed25519KeyPairGenerator()
        generator.init(Ed25519KeyGenerationParameters(secureRandom))

        val keyPair = generator.generateKeyPair()
        val privateKey = keyPair.private as Ed25519PrivateKeyParameters
        val publicKey = keyPair.public as Ed25519PublicKeyParameters

        // Ed25519 private key format: 32 bytes seed + 32 bytes public key = 64 bytes
        val privateKeyBytes = ByteArray(64)
        System.arraycopy(privateKey.encoded, 0, privateKeyBytes, 0, 32)
        System.arraycopy(publicKey.encoded, 0, privateKeyBytes, 32, 32)

        // Generate X25519 public key from the same seed
        val x25519PrivateBytes = ed25519SeedToX25519Private(privateKey.encoded)
        val x25519Private = X25519PrivateKeyParameters(x25519PrivateBytes, 0)
        val x25519PublicKey = x25519Private.generatePublicKey().encoded

        return KeyPair(
            publicKey = publicKey.encoded,
            privateKey = privateKeyBytes,
            x25519PublicKey = x25519PublicKey
        )
    }

    /**
     * Generates a deterministic Ed25519 key pair from a seed.
     *
     * @param seed 32-byte seed value
     * @return A key pair derived from the seed
     */
    fun generateKeyPairFromSeed(seed: ByteArray): KeyPair {
        require(seed.size == 32) { "Seed must be 32 bytes" }

        val privateKey = Ed25519PrivateKeyParameters(seed, 0)
        val publicKey = privateKey.generatePublicKey()

        // Ed25519 private key format: 32 bytes seed + 32 bytes public key = 64 bytes
        val privateKeyBytes = ByteArray(64)
        System.arraycopy(seed, 0, privateKeyBytes, 0, 32)
        System.arraycopy(publicKey.encoded, 0, privateKeyBytes, 32, 32)

        // Generate X25519 public key from the same seed
        val x25519PrivateBytes = ed25519SeedToX25519Private(seed)
        val x25519Private = X25519PrivateKeyParameters(x25519PrivateBytes, 0)
        val x25519PublicKey = x25519Private.generatePublicKey().encoded

        return KeyPair(
            publicKey = publicKey.encoded,
            privateKey = privateKeyBytes,
            x25519PublicKey = x25519PublicKey
        )
    }

    /**
     * Generates a random 32-byte session key.
     *
     * @return A new random session key
     */
    fun generateSessionKey(): ByteArray {
        val key = ByteArray(32)
        secureRandom.nextBytes(key)
        return key
    }

    /**
     * Derives a shared session key using X25519 key exchange.
     *
     * Both parties can derive the same session key:
     * - Device: deriveSessionKey(devicePrivate, controllerX25519Public)
     * - Controller: deriveSessionKey(controllerPrivate, deviceX25519Public)
     *
     * @param privateKey The local party's Ed25519 private key (64 bytes)
     * @param x25519PublicKey The remote party's X25519 public key (32 bytes)
     * @return A 32-byte shared session key
     */
    fun deriveSessionKey(privateKey: ByteArray, x25519PublicKey: ByteArray): ByteArray {
        require(privateKey.size == 64) { "Private key must be 64 bytes" }
        require(x25519PublicKey.size == 32) { "X25519 public key must be 32 bytes" }

        // Extract the 32-byte seed from the Ed25519 private key
        val seed = privateKey.copyOfRange(0, 32)

        // Convert Ed25519 seed to X25519 private key
        val x25519PrivateBytes = ed25519SeedToX25519Private(seed)
        val x25519Private = X25519PrivateKeyParameters(x25519PrivateBytes, 0)

        // Use the remote party's X25519 public key directly
        val x25519Public = X25519PublicKeyParameters(x25519PublicKey, 0)

        // Perform X25519 key agreement
        val agreement = X25519Agreement()
        agreement.init(x25519Private)

        val sharedSecret = ByteArray(agreement.agreementSize)
        agreement.calculateAgreement(x25519Public, sharedSecret, 0)

        // Derive session key using HKDF
        return hkdfDerive(sharedSecret, SESSION_KEY_INFO, 32)
    }

    /**
     * Signs a message using Ed25519.
     *
     * @param message The message to sign
     * @param privateKey The signer's private key (64 bytes)
     * @return A 64-byte signature
     */
    fun sign(message: ByteArray, privateKey: ByteArray): ByteArray {
        require(privateKey.size == 64) { "Private key must be 64 bytes" }

        // Extract the 32-byte seed from our private key format
        val seed = privateKey.copyOfRange(0, 32)
        val privateKeyParams = Ed25519PrivateKeyParameters(seed, 0)

        val signer = Ed25519Signer()
        signer.init(true, privateKeyParams)
        signer.update(message, 0, message.size)

        return signer.generateSignature()
    }

    /**
     * Verifies an Ed25519 signature.
     *
     * @param message The original message
     * @param signature The signature to verify (64 bytes)
     * @param publicKey The signer's public key (32 bytes)
     * @return true if the signature is valid
     */
    fun verify(message: ByteArray, signature: ByteArray, publicKey: ByteArray): Boolean {
        if (signature.size != 64) return false
        if (publicKey.size != 32) return false

        return try {
            val publicKeyParams = Ed25519PublicKeyParameters(publicKey, 0)

            val verifier = Ed25519Signer()
            verifier.init(false, publicKeyParams)
            verifier.update(message, 0, message.size)

            verifier.verifySignature(signature)
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Converts an Ed25519 seed to an X25519 private key.
     *
     * This follows RFC 8032 / libsodium conversion:
     * 1. Hash the seed with SHA-512
     * 2. Take first 32 bytes
     * 3. Clamp for X25519
     */
    private fun ed25519SeedToX25519Private(seed: ByteArray): ByteArray {
        // Hash the seed with SHA-512
        val digest = SHA512Digest()
        val hash = ByteArray(64)
        digest.update(seed, 0, seed.size)
        digest.doFinal(hash, 0)

        // Take first 32 bytes and clamp for X25519
        val x25519Key = hash.copyOfRange(0, 32)
        x25519Key[0] = (x25519Key[0].toInt() and 248).toByte()
        x25519Key[31] = (x25519Key[31].toInt() and 127).toByte()
        x25519Key[31] = (x25519Key[31].toInt() or 64).toByte()

        return x25519Key
    }

    /**
     * Derives a key using HKDF-SHA256.
     */
    private fun hkdfDerive(inputKey: ByteArray, info: ByteArray, length: Int): ByteArray {
        val hkdf = HKDFBytesGenerator(SHA256Digest())
        hkdf.init(HKDFParameters(inputKey, null, info))

        val output = ByteArray(length)
        hkdf.generateBytes(output, 0, length)
        return output
    }
}

/**
 * A cryptographic key pair supporting both Ed25519 (signing) and X25519 (key exchange).
 *
 * @property publicKey 32-byte Ed25519 public key (for identity and signature verification)
 * @property privateKey 64-byte private key (32-byte seed + 32-byte Ed25519 public key)
 * @property x25519PublicKey 32-byte X25519 public key (for key exchange)
 */
data class KeyPair(
    val publicKey: ByteArray,
    val privateKey: ByteArray,
    val x25519PublicKey: ByteArray
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (javaClass != other?.javaClass) return false
        other as KeyPair
        return publicKey.contentEquals(other.publicKey) &&
                privateKey.contentEquals(other.privateKey) &&
                x25519PublicKey.contentEquals(other.x25519PublicKey)
    }

    override fun hashCode(): Int {
        var result = publicKey.contentHashCode()
        result = 31 * result + privateKey.contentHashCode()
        result = 31 * result + x25519PublicKey.contentHashCode()
        return result
    }
}
