package com.androidremote.app.api

import android.util.Log
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.get
import io.ktor.client.request.patch
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json

/**
 * HTTP client for the device command polling API.
 *
 * Used by [CommandPollingService] to fetch pending commands and acknowledge
 * execution results.
 */
class CommandApiClient(
    private val baseUrl: String,
    private val deviceId: String,
    private val httpClient: HttpClient = createDefaultClient()
) {
    companion object {
        private const val TAG = "CommandApiClient"

        fun createDefaultClient(): HttpClient {
            return HttpClient(OkHttp) {
                install(ContentNegotiation) {
                    json(Json {
                        ignoreUnknownKeys = true
                        isLenient = true
                    })
                }
            }
        }
    }

    /**
     * Fetch pending commands for this device.
     *
     * This also acts as a heartbeat - the server updates lastSeenAt when called.
     *
     * @return List of pending commands
     * @throws CommandApiException on failure
     */
    suspend fun getPendingCommands(): List<DeviceCommand> {
        Log.d(TAG, "Fetching pending commands for device $deviceId")

        val response: HttpResponse = httpClient.get("$baseUrl/api/devices/$deviceId/commands/pending")

        return when (response.status) {
            HttpStatusCode.OK -> {
                val body: PendingCommandsResponse = response.body()
                Log.d(TAG, "Received ${body.commands.size} pending commands")
                body.commands
            }
            HttpStatusCode.NotFound -> {
                Log.w(TAG, "Device not found on server")
                throw CommandApiException("Device not found", CommandApiErrorType.DEVICE_NOT_FOUND)
            }
            else -> {
                Log.e(TAG, "Failed to fetch commands: ${response.status}")
                throw CommandApiException(
                    "Failed to fetch commands (${response.status})",
                    CommandApiErrorType.SERVER_ERROR
                )
            }
        }
    }

    /**
     * Acknowledge command as executing.
     *
     * Call this before starting command execution to let the server know
     * the command was received.
     *
     * @param commandId The command ID to acknowledge
     * @return true if acknowledged successfully
     */
    suspend fun markExecuting(commandId: String): Boolean {
        return acknowledgeCommand(commandId, CommandStatus.executing, null)
    }

    /**
     * Acknowledge command as completed successfully.
     *
     * @param commandId The command ID to acknowledge
     * @return true if acknowledged successfully
     */
    suspend fun markCompleted(commandId: String): Boolean {
        return acknowledgeCommand(commandId, CommandStatus.completed, null)
    }

    /**
     * Acknowledge command as failed.
     *
     * @param commandId The command ID to acknowledge
     * @param errorMessage Description of the failure
     * @return true if acknowledged successfully
     */
    suspend fun markFailed(commandId: String, errorMessage: String): Boolean {
        return acknowledgeCommand(commandId, CommandStatus.failed, errorMessage)
    }

    /**
     * Acknowledge command status.
     *
     * @param commandId The command ID to acknowledge
     * @param status New status (executing, completed, failed)
     * @param error Error message if status is failed
     * @return true if acknowledged successfully
     */
    private suspend fun acknowledgeCommand(
        commandId: String,
        status: CommandStatus,
        error: String?
    ): Boolean {
        Log.d(TAG, "Acknowledging command $commandId with status $status")

        val maxRetries = 3
        var lastException: Exception? = null

        for (attempt in 1..maxRetries) {
            try {
                val response: HttpResponse = httpClient.patch(
                    "$baseUrl/api/devices/$deviceId/commands/$commandId"
                ) {
                    contentType(ContentType.Application.Json)
                    setBody(CommandAcknowledgeRequest(
                        status = status.name,
                        error = error
                    ))
                }

                return when (response.status) {
                    HttpStatusCode.OK -> {
                        Log.d(TAG, "Command $commandId acknowledged as $status")
                        true
                    }
                    HttpStatusCode.NotFound -> {
                        Log.w(TAG, "Command $commandId not found")
                        false
                    }
                    else -> {
                        Log.e(TAG, "Failed to acknowledge command: ${response.status}")
                        false
                    }
                }
            } catch (e: Exception) {
                lastException = e
                if (attempt < maxRetries) {
                    val backoffMs = (1L shl attempt) * 1000L // 2s, 4s, 8s
                    Log.w(TAG, "Acknowledge attempt $attempt/$maxRetries failed for command $commandId, retrying in ${backoffMs}ms: ${e.message}")
                    delay(backoffMs)
                }
            }
        }

        Log.e(TAG, "All $maxRetries attempts to acknowledge command $commandId as $status failed", lastException)
        return false
    }

    /**
     * Close the HTTP client.
     */
    fun close() {
        httpClient.close()
    }
}

/**
 * Types of command API errors.
 */
enum class CommandApiErrorType {
    DEVICE_NOT_FOUND,
    NETWORK,
    SERVER_ERROR
}

/**
 * Exception thrown during command API operations.
 */
class CommandApiException(
    override val message: String,
    val errorType: CommandApiErrorType
) : Exception(message)
