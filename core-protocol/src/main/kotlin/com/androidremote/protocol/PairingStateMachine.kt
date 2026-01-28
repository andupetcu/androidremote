package com.androidremote.protocol

import com.androidremote.crypto.CryptoService
import java.security.SecureRandom

/**
 * States in the pairing protocol.
 */
enum class PairingState {
    /** Initial state, no pairing in progress */
    IDLE,
    /** Pairing code generated, waiting for controller to enter it */
    AWAITING_CODE,
    /** Code verified, exchanging cryptographic keys */
    EXCHANGING_KEYS,
    /** Pairing complete, session key established */
    PAIRED,
    /** Too many failed attempts, pairing locked */
    LOCKED_OUT
}

/**
 * State machine for the device-side pairing protocol.
 *
 * Flow:
 * 1. Device generates a 6-digit pairing code
 * 2. User enters the code on the controller (web UI)
 * 3. If code matches, exchange public keys
 * 4. Derive shared session key
 * 5. Pairing complete
 *
 * Security features:
 * - Code expires after timeout (default: 5 minutes)
 * - Lockout after 3 failed attempts
 * - Session key derived via X25519 key exchange
 *
 * @param codeTimeoutMs How long the pairing code is valid (default: 5 minutes)
 * @param maxFailedAttempts How many wrong codes before lockout (default: 3)
 */
class PairingStateMachine(
    private val codeTimeoutMs: Long = 5 * 60 * 1000L,
    private val maxFailedAttempts: Int = 3
) {
    private val secureRandom = SecureRandom()

    /** Device's key pair for this pairing session */
    private var deviceKeyPair = CryptoService.generateKeyPair()

    /** Current state of the pairing process */
    var state: PairingState = PairingState.IDLE
        private set

    /** Number of failed code entry attempts */
    var failedAttempts: Int = 0
        private set

    /** The current pairing code (null if not in AWAITING_CODE state) */
    var currentPairingCode: String? = null
        private set

    /** Timestamp when the pairing code was generated */
    private var codeGeneratedAt: Long = 0

    /** The controller's public key (set after successful pairing) */
    var controllerPublicKey: ByteArray? = null
        private set

    /** The derived session key (set after successful pairing) */
    var sessionKey: ByteArray? = null
        private set

    /**
     * Generates a new 6-digit pairing code and transitions to AWAITING_CODE.
     *
     * If already in AWAITING_CODE, returns the existing code.
     *
     * @return The 6-digit pairing code
     */
    fun generatePairingCode(): String {
        // If already awaiting code, return the existing one
        if (state == PairingState.AWAITING_CODE && currentPairingCode != null) {
            return currentPairingCode!!
        }

        // Generate a 6-digit code using SecureRandom
        val code = (0 until 6)
            .map { secureRandom.nextInt(10) }
            .joinToString("")

        currentPairingCode = code
        codeGeneratedAt = System.currentTimeMillis()
        state = PairingState.AWAITING_CODE

        return code
    }

    /**
     * Called when the controller enters a pairing code.
     *
     * @param code The code entered by the user
     * @return true if the code is correct, false otherwise
     */
    fun onCodeEntered(code: String): Boolean {
        // Cannot enter code if locked out
        if (state == PairingState.LOCKED_OUT) {
            return false
        }

        // Must be in AWAITING_CODE state
        if (state != PairingState.AWAITING_CODE) {
            return false
        }

        // Check if code matches using constant-time comparison
        if (constantTimeEquals(code, currentPairingCode ?: "")) {
            state = PairingState.EXCHANGING_KEYS
            return true
        }

        // Wrong code - increment failed attempts
        failedAttempts++

        // Check for lockout
        if (failedAttempts >= maxFailedAttempts) {
            state = PairingState.LOCKED_OUT
        }

        return false
    }

    /**
     * Called when key exchange is complete.
     *
     * @param controllerX25519PublicKey The controller's X25519 public key for key exchange
     */
    fun onKeyExchangeComplete(controllerX25519PublicKey: ByteArray) {
        require(state == PairingState.EXCHANGING_KEYS) {
            "Cannot complete key exchange in state $state"
        }
        require(controllerX25519PublicKey.size == 32) {
            "Controller X25519 public key must be 32 bytes"
        }

        this.controllerPublicKey = controllerX25519PublicKey.copyOf()

        // Derive session key using X25519 key exchange
        sessionKey = CryptoService.deriveSessionKey(
            deviceKeyPair.privateKey,
            controllerX25519PublicKey
        )

        state = PairingState.PAIRED
    }

    /**
     * Checks if the current pairing code is still valid (not expired).
     *
     * @return true if the code is valid, false if expired or not generated
     */
    fun isPairingCodeValid(): Boolean {
        if (currentPairingCode == null) {
            return false
        }

        val elapsed = System.currentTimeMillis() - codeGeneratedAt
        return elapsed <= codeTimeoutMs
    }

    /**
     * Resets the state machine to IDLE.
     */
    fun reset() {
        state = PairingState.IDLE
        failedAttempts = 0
        currentPairingCode = null
        codeGeneratedAt = 0
        controllerPublicKey = null
        sessionKey = null
        // Generate a fresh key pair for the next pairing session
        deviceKeyPair = CryptoService.generateKeyPair()
    }

    /**
     * Gets the device's Ed25519 public key for identity verification.
     *
     * @return The device's Ed25519 public key (32 bytes)
     */
    fun getDevicePublicKey(): ByteArray = deviceKeyPair.publicKey.copyOf()

    /**
     * Gets the device's X25519 public key for key exchange.
     *
     * @return The device's X25519 public key (32 bytes)
     */
    fun getDeviceX25519PublicKey(): ByteArray = deviceKeyPair.x25519PublicKey.copyOf()

    /**
     * Constant-time string comparison to prevent timing attacks.
     */
    private fun constantTimeEquals(a: String, b: String): Boolean {
        if (a.length != b.length) {
            return false
        }

        var result = 0
        for (i in a.indices) {
            result = result or (a[i].code xor b[i].code)
        }
        return result == 0
    }
}
