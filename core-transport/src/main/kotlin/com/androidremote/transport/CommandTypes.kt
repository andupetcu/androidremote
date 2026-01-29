package com.androidremote.transport

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator

/**
 * Remote control commands sent from web UI to Android device.
 */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("type")
sealed class RemoteCommand {

    /**
     * Tap at normalized coordinates (0.0 to 1.0).
     */
    @Serializable
    @SerialName("TAP")
    data class Tap(
        val x: Float,
        val y: Float
    ) : RemoteCommand()

    /**
     * Swipe gesture with duration.
     */
    @Serializable
    @SerialName("SWIPE")
    data class Swipe(
        val startX: Float,
        val startY: Float,
        val endX: Float,
        val endY: Float,
        val durationMs: Int = 300
    ) : RemoteCommand()

    /**
     * Long press at coordinates.
     */
    @Serializable
    @SerialName("LONG_PRESS")
    data class LongPress(
        val x: Float,
        val y: Float,
        val durationMs: Int = 500
    ) : RemoteCommand()

    /**
     * Type text string.
     */
    @Serializable
    @SerialName("TYPE_TEXT")
    data class TypeText(
        val text: String
    ) : RemoteCommand()

    /**
     * Press a key by Android keycode.
     */
    @Serializable
    @SerialName("KEY_PRESS")
    data class KeyPress(
        val keyCode: Int
    ) : RemoteCommand()

    /**
     * Pinch/zoom gesture.
     */
    @Serializable
    @SerialName("PINCH")
    data class Pinch(
        val centerX: Float,
        val centerY: Float,
        val scale: Float,
        val durationMs: Int = 300
    ) : RemoteCommand()

    /**
     * Multiple taps at the same location with precise timing.
     * Used for double-tap, triple-tap, etc.
     */
    @Serializable
    @SerialName("MULTI_TAP")
    data class MultiTap(
        val x: Float,
        val y: Float,
        val count: Int = 3,
        val intervalMs: Int = 100
    ) : RemoteCommand()

    /**
     * Scroll in a direction.
     */
    @Serializable
    @SerialName("SCROLL")
    data class Scroll(
        val x: Float,
        val y: Float,
        val deltaX: Float,
        val deltaY: Float
    ) : RemoteCommand()

    // ==================== MDM Commands ====================

    /**
     * Get device status information (battery, storage, connectivity).
     */
    @Serializable
    @SerialName("GET_DEVICE_INFO")
    data object GetDeviceInfo : RemoteCommand()

    /**
     * Lock the device screen immediately.
     * Requires Device Admin or Device Owner privileges.
     */
    @Serializable
    @SerialName("LOCK_DEVICE")
    data object LockDevice : RemoteCommand()

    /**
     * Install an app from a URL.
     * Requires Device Owner privileges.
     */
    @Serializable
    @SerialName("INSTALL_APP")
    data class InstallApp(
        val packageName: String,
        val apkUrl: String
    ) : RemoteCommand()

    /**
     * Uninstall an app by package name.
     * Requires Device Owner privileges.
     */
    @Serializable
    @SerialName("UNINSTALL_APP")
    data class UninstallApp(
        val packageName: String
    ) : RemoteCommand()

    /**
     * Reboot the device.
     * Requires Device Owner privileges on Android 7.0+.
     */
    @Serializable
    @SerialName("REBOOT_DEVICE")
    data object RebootDevice : RemoteCommand()

    /**
     * Factory reset the device. USE WITH EXTREME CAUTION.
     * Requires Device Owner privileges.
     */
    @Serializable
    @SerialName("WIPE_DEVICE")
    data class WipeDevice(
        val wipeExternalStorage: Boolean = false
    ) : RemoteCommand()

    /**
     * List installed applications on the device.
     */
    @Serializable
    @SerialName("LIST_APPS")
    data class ListApps(
        val includeSystemApps: Boolean = false
    ) : RemoteCommand()
}

/**
 * Command envelope with unique ID for tracking acknowledgments.
 */
@Serializable
data class CommandEnvelope(
    val id: String,
    val command: RemoteCommand,
    val timestamp: Long = System.currentTimeMillis()
)

/**
 * Acknowledgment from device after processing a command.
 */
@Serializable
data class CommandAck(
    val commandId: String,
    val success: Boolean,
    val errorMessage: String? = null,
    val data: CommandResponseData? = null,
    val timestamp: Long = System.currentTimeMillis()
)

/**
 * Response data for commands that return information.
 */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("type")
sealed class CommandResponseData {

    /**
     * Device status information response.
     */
    @Serializable
    @SerialName("DEVICE_INFO")
    data class DeviceInfo(
        val deviceName: String,
        val model: String,
        val manufacturer: String,
        val androidVersion: String,
        val sdkVersion: Int,
        val batteryLevel: Int,
        val isCharging: Boolean,
        val wifiConnected: Boolean,
        val freeStorageBytes: Long,
        val totalStorageBytes: Long,
        val isDeviceOwner: Boolean,
        val isDeviceAdmin: Boolean
    ) : CommandResponseData()

    /**
     * List of installed applications.
     */
    @Serializable
    @SerialName("APP_LIST")
    data class AppList(
        val apps: List<AppInfo>
    ) : CommandResponseData()
}

/**
 * Information about an installed application.
 */
@Serializable
data class AppInfo(
    val packageName: String,
    val appName: String,
    val versionName: String?,
    val versionCode: Long,
    val isSystemApp: Boolean
)
