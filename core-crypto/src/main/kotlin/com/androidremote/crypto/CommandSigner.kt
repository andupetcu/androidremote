package com.androidremote.crypto

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.macs.HMac
import org.bouncycastle.crypto.params.KeyParameter
import java.util.Base64

/**
 * A command to be sent from the controller to the device.
 *
 * @property type The command type (e.g., "TAP", "SWIPE", "LONG_PRESS")
 * @property payload Command-specific data as key-value pairs
 */
@Serializable
data class Command(
    val type: String,
    val payload: Map<String, JsonElement> = emptyMap()
)

/**
 * A signed command with HMAC and timestamp for integrity and replay protection.
 *
 * @property command The original command
 * @property hmac HMAC-SHA256 of the command + timestamp using the session key (Base64)
 * @property timestamp Unix timestamp in milliseconds when the command was signed
 */
@Serializable
data class SignedCommand(
    val command: Command,
    val hmac: String,
    val timestamp: Long
)

/**
 * Signs and verifies commands using HMAC-SHA256.
 *
 * Commands are signed with a session key to:
 * 1. Prevent tampering (integrity)
 * 2. Prevent replay attacks (timestamp validation)
 * 3. Authenticate the sender (only parties with the session key can sign)
 */
object CommandSigner {

    private val json = Json {
        encodeDefaults = true
        // Ensure consistent ordering for HMAC
        prettyPrint = false
    }

    /**
     * Default maximum age for commands (30 seconds).
     */
    const val DEFAULT_MAX_AGE_MS = 30_000L

    /**
     * Signs a command with the current timestamp.
     *
     * @param command The command to sign
     * @param sessionKey The 32-byte session key
     * @return A signed command with HMAC and timestamp
     */
    fun sign(command: Command, sessionKey: ByteArray): SignedCommand {
        return signWithTimestamp(command, sessionKey, System.currentTimeMillis())
    }

    /**
     * Signs a command with a specific timestamp.
     *
     * This is primarily for testing replay attack protection.
     *
     * @param command The command to sign
     * @param sessionKey The 32-byte session key
     * @param timestamp The timestamp to use
     * @return A signed command with HMAC and timestamp
     */
    fun signWithTimestamp(command: Command, sessionKey: ByteArray, timestamp: Long): SignedCommand {
        require(sessionKey.size == 32) { "Session key must be 32 bytes" }

        val hmac = computeHmac(command, timestamp, sessionKey)

        return SignedCommand(
            command = command,
            hmac = hmac,
            timestamp = timestamp
        )
    }

    /**
     * Verifies a signed command.
     *
     * @param signedCommand The command to verify
     * @param sessionKey The 32-byte session key
     * @param maxAgeMs Maximum age of the command in milliseconds (default: 30 seconds)
     * @return true if the command is valid and not expired
     */
    fun verify(
        signedCommand: SignedCommand,
        sessionKey: ByteArray,
        maxAgeMs: Long = DEFAULT_MAX_AGE_MS
    ): Boolean {
        require(sessionKey.size == 32) { "Session key must be 32 bytes" }

        // Check timestamp is not too old (replay protection)
        val now = System.currentTimeMillis()
        val age = now - signedCommand.timestamp
        if (age > maxAgeMs || age < -maxAgeMs) {
            // Also reject commands from the "future" (clock skew protection)
            return false
        }

        // Recompute HMAC and compare
        val expectedHmac = computeHmac(signedCommand.command, signedCommand.timestamp, sessionKey)

        // Constant-time comparison to prevent timing attacks
        return constantTimeEquals(signedCommand.hmac, expectedHmac)
    }

    /**
     * Computes HMAC-SHA256 of the command and timestamp.
     *
     * The message format is: JSON(command) + "|" + timestamp
     * This ensures both the command content and timestamp are authenticated.
     */
    internal fun computeHmac(command: Command, timestamp: Long, sessionKey: ByteArray): String {
        // Create the message to authenticate
        val commandJson = json.encodeToString(command)
        val message = "$commandJson|$timestamp"
        val messageBytes = message.toByteArray(Charsets.UTF_8)

        // Compute HMAC-SHA256
        val hmac = HMac(SHA256Digest())
        hmac.init(KeyParameter(sessionKey))
        hmac.update(messageBytes, 0, messageBytes.size)

        val result = ByteArray(hmac.macSize)
        hmac.doFinal(result, 0)

        // Return Base64 encoded
        return Base64.getEncoder().encodeToString(result)
    }

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
