package com.androidremote.feature.input

import com.androidremote.crypto.CommandSigner
import java.security.SecureRandom
import java.util.Base64

/**
 * Bridge to communicate with the root daemon via Unix domain socket.
 *
 * This class handles:
 * - Socket connection management
 * - Command signing with HMAC-SHA256
 * - Nonce generation for replay protection
 * - Response handling
 *
 * ## Security Model
 *
 * Commands are signed using HMAC-SHA256 with a shared session key:
 * - The key is derived during the secure pairing process
 * - Each command includes a timestamp to prevent replay attacks
 * - Each command includes a unique nonce for additional replay protection
 *
 * ## Usage
 *
 * ```kotlin
 * val bridge = RootDaemonBridge(
 *     socketFactory = { UnixDomainSocketWrapper() },
 *     sessionKey = derivedSessionKey
 * )
 *
 * bridge.connect()
 * bridge.sendCommand(DaemonCommand.Tap(x = 100, y = 200))
 * bridge.disconnect()
 * ```
 *
 * @param socketFactory Factory function to create socket instances
 * @param sessionKey 32-byte session key for command signing
 */
class RootDaemonBridge(
    private val socketFactory: () -> DaemonSocket,
    sessionKey: ByteArray
) {
    companion object {
        /** Default socket path on Android. */
        const val DEFAULT_SOCKET_PATH = "/dev/socket/android_remote"

        /** Size of nonces in bytes before Base64 encoding. */
        private const val NONCE_SIZE = 16
    }

    init {
        require(sessionKey.isNotEmpty()) { "Session key cannot be empty" }
        require(sessionKey.size == 32) { "Session key must be 32 bytes, got ${sessionKey.size}" }
    }

    private var _sessionKey: ByteArray = sessionKey.copyOf()
    private var socket: DaemonSocket? = null
    private val random = SecureRandom()

    /**
     * Whether the bridge is currently connected to the daemon.
     */
    val isConnected: Boolean
        get() = socket?.isConnected() == true

    /**
     * Connect to the daemon socket.
     *
     * @param socketPath Path to the Unix domain socket (default: /dev/socket/android_remote)
     * @throws DaemonConnectionException if connection fails
     */
    suspend fun connect(socketPath: String = DEFAULT_SOCKET_PATH) {
        try {
            val newSocket = socketFactory()
            newSocket.connect(socketPath)
            socket = newSocket
        } catch (e: Exception) {
            throw DaemonConnectionException("Failed to connect to daemon at $socketPath", e)
        }
    }

    /**
     * Disconnect from the daemon.
     */
    fun disconnect() {
        socket?.close()
        socket = null
    }

    /**
     * Send a command to the daemon.
     *
     * The command is signed with the session key and includes a timestamp
     * and nonce for replay protection.
     *
     * @param command The command to send
     * @return Result indicating success or failure
     * @throws DaemonDisconnectedException if not connected
     * @throws DaemonCommandException if the daemon returns an error
     */
    suspend fun sendCommand(command: DaemonCommand): CommandResult {
        val currentSocket = socket
            ?: throw DaemonDisconnectedException()

        if (!currentSocket.isConnected()) {
            socket = null
            throw DaemonDisconnectedException()
        }

        try {
            // Convert to signed command
            val cryptoCommand = command.toCommand()
            val signedCryptoCommand = CommandSigner.sign(cryptoCommand, _sessionKey)

            // Create daemon command with nonce
            val signedCommand = SignedDaemonCommand(
                command = signedCryptoCommand.command,
                hmac = signedCryptoCommand.hmac,
                timestamp = signedCryptoCommand.timestamp,
                nonce = generateNonce()
            )

            // Send command
            currentSocket.write(signedCommand)

            // Read response
            return when (val response = currentSocket.read()) {
                is DaemonResponse.Ok -> CommandResult.Success
                is DaemonResponse.Error -> throw DaemonCommandException(response.message)
            }
        } catch (e: DaemonCommandException) {
            throw e
        } catch (e: Exception) {
            // Socket error - mark as disconnected
            socket = null
            throw DaemonDisconnectedException("Lost connection to daemon: ${e.message}")
        }
    }

    /**
     * Update the session key for command signing.
     *
     * This may be needed during key rotation or after re-pairing.
     *
     * @param newKey The new 32-byte session key
     */
    fun updateSessionKey(newKey: ByteArray) {
        require(newKey.size == 32) { "Session key must be 32 bytes" }
        _sessionKey = newKey.copyOf()
    }

    /**
     * Generate a unique nonce for replay protection.
     */
    private fun generateNonce(): String {
        val bytes = ByteArray(NONCE_SIZE)
        random.nextBytes(bytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }
}
