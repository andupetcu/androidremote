package com.androidremote.feature.input

import com.androidremote.crypto.Command
import com.androidremote.crypto.SignedCommand
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive

/**
 * Commands that can be sent to the root daemon.
 *
 * These are converted to [SignedCommand] before sending to the daemon.
 */
sealed class DaemonCommand {
    /**
     * Tap at screen coordinates.
     */
    data class Tap(val x: Int, val y: Int) : DaemonCommand()

    /**
     * Long press at screen coordinates.
     *
     * @param durationMs How long to hold the press in milliseconds
     */
    data class LongPress(val x: Int, val y: Int, val durationMs: Long) : DaemonCommand()

    /**
     * Swipe from start to end coordinates.
     *
     * @param durationMs How long the swipe should take in milliseconds
     */
    data class Swipe(
        val startX: Int,
        val startY: Int,
        val endX: Int,
        val endY: Int,
        val durationMs: Long
    ) : DaemonCommand()

    /**
     * Key press event.
     *
     * @param code Android KeyEvent code
     */
    data class Key(val code: Int) : DaemonCommand()

    /**
     * Text input (simulates typing).
     */
    data class Text(val text: String) : DaemonCommand()

    /**
     * Convert this command to a [Command] for signing.
     */
    internal fun toCommand(): Command = when (this) {
        is Tap -> Command(
            type = "TAP",
            payload = mapOf(
                "x" to JsonPrimitive(x),
                "y" to JsonPrimitive(y)
            )
        )
        is LongPress -> Command(
            type = "LONG_PRESS",
            payload = mapOf(
                "x" to JsonPrimitive(x),
                "y" to JsonPrimitive(y),
                "duration_ms" to JsonPrimitive(durationMs)
            )
        )
        is Swipe -> Command(
            type = "SWIPE",
            payload = mapOf(
                "start_x" to JsonPrimitive(startX),
                "start_y" to JsonPrimitive(startY),
                "end_x" to JsonPrimitive(endX),
                "end_y" to JsonPrimitive(endY),
                "duration_ms" to JsonPrimitive(durationMs)
            )
        )
        is Key -> Command(
            type = "KEY",
            payload = mapOf("code" to JsonPrimitive(code))
        )
        is Text -> Command(
            type = "TEXT",
            payload = mapOf("text" to JsonPrimitive(text))
        )
    }
}

/**
 * Signed command for daemon communication.
 *
 * This wraps a [SignedCommand] with an additional nonce for replay protection.
 */
@Serializable
data class SignedDaemonCommand(
    val command: Command,
    val hmac: String,
    val timestamp: Long,
    val nonce: String
)

/**
 * Response from the daemon.
 */
sealed class DaemonResponse {
    /**
     * Command executed successfully.
     */
    data object Ok : DaemonResponse()

    /**
     * Command failed with an error message.
     */
    data class Error(val message: String) : DaemonResponse()
}

/**
 * Result of sending a command.
 */
sealed class CommandResult {
    /**
     * Command executed successfully.
     */
    data object Success : CommandResult()

    /**
     * Command failed with an error.
     */
    data class Failure(val reason: String) : CommandResult()
}

/**
 * Socket interface for daemon communication.
 *
 * Abstracts the Unix domain socket to allow mocking in tests.
 */
interface DaemonSocket {
    /**
     * Connect to the daemon socket at the given path.
     *
     * @throws IOException if connection fails
     */
    suspend fun connect(path: String)

    /**
     * Write a signed command to the daemon.
     *
     * @throws IOException if write fails
     */
    suspend fun write(command: SignedDaemonCommand)

    /**
     * Read a response from the daemon.
     *
     * @throws IOException if read fails
     */
    suspend fun read(): DaemonResponse

    /**
     * Close the socket connection.
     */
    fun close()

    /**
     * Check if the socket is connected.
     */
    fun isConnected(): Boolean
}

/**
 * Exception thrown when connection to daemon fails.
 */
class DaemonConnectionException(message: String, cause: Throwable? = null) :
    Exception(message, cause)

/**
 * Exception thrown when the daemon is disconnected.
 */
class DaemonDisconnectedException(message: String = "Daemon is not connected") :
    Exception(message)

/**
 * Exception thrown when a command fails on the daemon side.
 */
class DaemonCommandException(message: String) : Exception(message)
