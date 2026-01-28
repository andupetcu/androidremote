package com.androidremote.app.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * Command types supported by the MDM system.
 */
enum class CommandType {
    INSTALL_APK,
    UNINSTALL_APP,
    LOCK,
    REBOOT,
    WIPE,
    START_REMOTE
}

/**
 * Command status for tracking execution state.
 */
enum class CommandStatus {
    pending,
    delivered,
    executing,
    completed,
    failed
}

/**
 * Device command from the server.
 */
@Serializable
data class DeviceCommand(
    val id: String,
    val deviceId: String,
    val type: String,
    val payload: JsonObject,
    val status: String,
    val createdAt: Long,
    val deliveredAt: Long? = null,
    val completedAt: Long? = null,
    val error: String? = null
)

/**
 * Response from pending commands endpoint.
 */
@Serializable
data class PendingCommandsResponse(
    val commands: List<DeviceCommand>
)

/**
 * Request to acknowledge command status.
 */
@Serializable
data class CommandAcknowledgeRequest(
    val status: String,
    val error: String? = null
)

/**
 * Parsed payload for INSTALL_APK command.
 */
data class InstallApkPayload(
    val url: String,
    val packageName: String
)

/**
 * Parsed payload for UNINSTALL_APP command.
 */
data class UninstallAppPayload(
    val packageName: String
)

/**
 * Parsed payload for WIPE command.
 */
data class WipePayload(
    val keepData: Boolean = false
)

/**
 * Parsed payload for START_REMOTE command.
 */
data class StartRemotePayload(
    val signalingUrl: String
)
