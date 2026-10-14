package com.androidremote.app.api

import android.util.Log
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

/**
 * HTTP client for the device command polling API.
 *
 * Used by [CommandPollingService] to fetch pending commands and acknowledge
 * execution results.
 */
class CommandApiClient(
    private val baseUrl: String,
    private val deviceId: String,
    private val httpClient: HttpClient
) : CommandAcks {
    companion object {
        private const val TAG = "CommandApiClient"
        private const val ACK_MAX_ATTEMPTS = 3
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
            HttpStatusCode.Unauthorized -> {
                Log.w(TAG, "Session token rejected by server")
                throw CommandApiException("Unauthorized", CommandApiErrorType.UNAUTHORIZED)
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

    suspend fun markExecuting(commandId: String): AckResult = ack(commandId, CommandStatus.executing, null)

    suspend fun markCompleted(commandId: String): AckResult = ack(commandId, CommandStatus.completed, null)

    suspend fun markFailed(commandId: String, errorMessage: String): AckResult =
        ack(commandId, CommandStatus.failed, errorMessage)

    /**
     * Acknowledge a command status.
     *
     * Network errors and 5xx are retried with backoff (2 s, 4 s). 401 is returned as
     * [AckResult.UNAUTHORIZED]. Other 4xx are permanent ([AckResult.REJECTED]) and not retried.
     * When every attempt fails the result is [AckResult.RETRY_LATER], and the caller queues it.
     */
    override suspend fun ack(commandId: String, status: CommandStatus, error: String?): AckResult {
        Log.d(TAG, "Acknowledging command $commandId with status $status")

        for (attempt in 1..ACK_MAX_ATTEMPTS) {
            val outcome = try {
                val response: HttpResponse = httpClient.patch(
                    "$baseUrl/api/devices/$deviceId/commands/$commandId"
                ) {
                    contentType(ContentType.Application.Json)
                    setBody(CommandAcknowledgeRequest(status = status.name, error = error))
                }
                val code = response.status.value
                when {
                    code in 200..299 -> AckResult.OK
                    code == 401 -> AckResult.UNAUTHORIZED
                    code in 400..499 -> AckResult.REJECTED
                    else -> AckResult.RETRY_LATER
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "Acknowledge attempt $attempt/$ACK_MAX_ATTEMPTS failed for command $commandId: ${e.message}")
                AckResult.RETRY_LATER
            }

            if (outcome != AckResult.RETRY_LATER) {
                if (outcome != AckResult.OK) Log.w(TAG, "Ack of $commandId as $status gave $outcome")
                return outcome
            }
            if (attempt < ACK_MAX_ATTEMPTS) delay((1L shl attempt) * 1000L) // 2s, 4s
        }

        Log.e(TAG, "All $ACK_MAX_ATTEMPTS attempts to acknowledge command $commandId as $status failed")
        return AckResult.RETRY_LATER
    }

    /** POST the telemetry JSON. Returns true on a 2xx response. */
    suspend fun postTelemetry(jsonBody: String): Boolean = postJson("telemetry", jsonBody)

    /** POST the app inventory JSON. Returns true on a 2xx response. */
    suspend fun postApps(jsonBody: String): Boolean = postJson("apps", jsonBody)

    private suspend fun postJson(path: String, jsonBody: String): Boolean {
        val response = httpClient.post("$baseUrl/api/devices/$deviceId/$path") {
            contentType(ContentType.Application.Json)
            setBody(jsonBody)
        }
        if (!response.status.isSuccess()) Log.w(TAG, "POST $path failed: ${response.status}")
        return response.status.isSuccess()
    }

    /** GET app-updates. Returns null when the server does not answer 200. */
    suspend fun getAppUpdates(): AppUpdatesResponse? {
        val response = httpClient.get("$baseUrl/api/devices/$deviceId/app-updates")
        if (response.status == HttpStatusCode.Unauthorized) {
            throw CommandApiException("Unauthorized", CommandApiErrorType.UNAUTHORIZED)
        }
        if (response.status != HttpStatusCode.OK) {
            Log.w(TAG, "App updates check failed: ${response.status}")
            return null
        }
        return response.body()
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
    UNAUTHORIZED,
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
) : Exception(message) {
    /** 401 or 404 on poll: the enrollment is no longer valid, so polling must stop. */
    val isEnrollmentInvalid: Boolean
        get() = errorType == CommandApiErrorType.UNAUTHORIZED || errorType == CommandApiErrorType.DEVICE_NOT_FOUND
}

/** Result of acknowledging a command status. */
enum class AckResult {
    OK,
    /** Permanent 4xx (unknown command, expired, bad state). Do not retry. */
    REJECTED,
    UNAUTHORIZED,
    /** Network error or 5xx. Queue the ack and resend later. */
    RETRY_LATER
}

/** Abstraction used by the command loop so it can be tested without HTTP. */
interface CommandAcks {
    suspend fun ack(commandId: String, status: CommandStatus, error: String?): AckResult
}
