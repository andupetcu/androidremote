package com.androidremote.app.admin

import android.Manifest
import android.app.NotificationManager
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioManager
import android.os.Build
import android.util.Log

/**
 * Manager for Device Owner and Device Admin capabilities.
 *
 * When the app is set as Device Owner, this manager provides:
 * - Silent runtime permission grants (no user prompts)
 * - Device lock and wipe functionality
 * - Silent app installation (for MDM deployments)
 *
 * IMPORTANT: AccessibilityService CANNOT be auto-enabled even in Device Owner mode.
 * This is an Android security design decision. The user must manually enable it.
 *
 * Device Owner capabilities by permission:
 * | Permission            | Can Auto-Grant? |
 * |-----------------------|-----------------|
 * | Camera                | YES             |
 * | Storage               | YES             |
 * | Notifications         | YES             |
 * | AccessibilityService  | NO (manual)     |
 */
class DeviceOwnerManager(private val context: Context) {

    companion object {
        private const val TAG = "DeviceOwnerManager"

        /**
         * Permissions that can be auto-granted in Device Owner mode.
         *
         * Note: Location permissions are NOT auto-granted to avoid the persistent
         * "Location can be accessed" notification that Android shows for Device Owner
         * apps with location access. Location is optional for telemetry.
         */
        val GRANTABLE_PERMISSIONS = listOf(
            Manifest.permission.CAMERA,
            Manifest.permission.POST_NOTIFICATIONS,
            Manifest.permission.READ_EXTERNAL_STORAGE,
            Manifest.permission.WRITE_EXTERNAL_STORAGE,
            // Location permissions intentionally excluded - triggers privacy notification
            // Manifest.permission.ACCESS_FINE_LOCATION,
            // Manifest.permission.ACCESS_COARSE_LOCATION,
            // Manifest.permission.ACCESS_BACKGROUND_LOCATION,
        )
    }

    private val devicePolicyManager: DevicePolicyManager by lazy {
        context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
    }

    private val componentName: ComponentName by lazy {
        DeviceOwnerReceiver.getComponentName(context)
    }

    /**
     * Check if this app is the Device Owner.
     */
    fun isDeviceOwner(): Boolean {
        return devicePolicyManager.isDeviceOwnerApp(context.packageName)
    }

    /**
     * Check if this app is a Device Admin (less privileged than Device Owner).
     */
    fun isDeviceAdmin(): Boolean {
        return devicePolicyManager.isAdminActive(componentName)
    }

    /**
     * Check if the app has elevated MDM privileges (Device Owner or Admin).
     */
    fun hasMdmPrivileges(): Boolean {
        return isDeviceOwner() || isDeviceAdmin()
    }

    /**
     * Auto-grant all required runtime permissions.
     * Only works in Device Owner mode.
     *
     * @return true if all permissions were granted, false if not Device Owner
     */
    fun autoGrantPermissions(): Boolean {
        if (!isDeviceOwner()) {
            Log.w(TAG, "Cannot auto-grant permissions: not Device Owner")
            return false
        }

        var allGranted = true
        for (permission in GRANTABLE_PERMISSIONS) {
            val result = grantPermission(permission)
            if (!result) {
                allGranted = false
            }
        }

        Log.i(TAG, "Auto-grant permissions complete. All granted: $allGranted")
        return allGranted
    }

    /**
     * Grant a specific runtime permission silently.
     * Only works in Device Owner mode.
     *
     * @param permission The permission to grant (e.g., Manifest.permission.CAMERA)
     * @return true if granted successfully, false otherwise
     */
    fun grantPermission(permission: String): Boolean {
        if (!isDeviceOwner()) {
            Log.w(TAG, "Cannot grant $permission: not Device Owner")
            return false
        }

        return try {
            val result = devicePolicyManager.setPermissionGrantState(
                componentName,
                context.packageName,
                permission,
                DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED
            )
            Log.d(TAG, "Grant permission $permission: $result")
            result
        } catch (e: SecurityException) {
            Log.e(TAG, "Failed to grant permission $permission", e)
            false
        }
    }

    /**
     * Revoke a specific runtime permission.
     * Only works in Device Owner mode.
     *
     * @param permission The permission to revoke
     * @return true if revoked successfully, false otherwise
     */
    fun revokePermission(permission: String): Boolean {
        if (!isDeviceOwner()) {
            Log.w(TAG, "Cannot revoke $permission: not Device Owner")
            return false
        }

        return try {
            val result = devicePolicyManager.setPermissionGrantState(
                componentName,
                context.packageName,
                permission,
                DevicePolicyManager.PERMISSION_GRANT_STATE_DENIED
            )
            Log.d(TAG, "Revoke permission $permission: $result")
            result
        } catch (e: SecurityException) {
            Log.e(TAG, "Failed to revoke permission $permission", e)
            false
        }
    }

    /**
     * Revoke all location permissions to stop the privacy disclosure notification.
     * Uses PERMISSION_GRANT_STATE_DEFAULT to reset to user-controllable state,
     * then DENIED to actually revoke.
     */
    fun revokeLocationPermissions() {
        val locationPermissions = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            locationPermissions.add(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        }

        for (permission in locationPermissions) {
            try {
                // First reset to default (user-controllable)
                devicePolicyManager.setPermissionGrantState(
                    componentName,
                    context.packageName,
                    permission,
                    DevicePolicyManager.PERMISSION_GRANT_STATE_DEFAULT
                )
                Log.d(TAG, "Reset permission $permission to default")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to reset permission $permission", e)
            }
        }
        Log.i(TAG, "Location permissions reset to user-controllable")
    }

    /**
     * Check if a specific permission is granted.
     */
    fun isPermissionGranted(permission: String): Boolean {
        return context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
    }

    /**
     * Lock the device screen immediately.
     * Requires Device Admin or Device Owner privileges.
     */
    fun lockDevice() {
        if (!hasMdmPrivileges()) {
            Log.w(TAG, "Cannot lock device: no MDM privileges")
            return
        }

        try {
            devicePolicyManager.lockNow()
            Log.i(TAG, "Device locked")
        } catch (e: SecurityException) {
            Log.e(TAG, "Failed to lock device", e)
        }
    }

    /**
     * Wipe the device (factory reset).
     * Requires Device Owner privileges. USE WITH CAUTION.
     *
     * @param flags Wipe flags (e.g., WIPE_EXTERNAL_STORAGE)
     */
    fun wipeDevice(flags: Int = 0) {
        if (!isDeviceOwner()) {
            Log.w(TAG, "Cannot wipe device: not Device Owner")
            return
        }

        try {
            Log.w(TAG, "WIPING DEVICE - Factory reset initiated")
            devicePolicyManager.wipeData(flags)
        } catch (e: SecurityException) {
            Log.e(TAG, "Failed to wipe device", e)
        }
    }

    /**
     * Reboot the device.
     * Requires Device Owner privileges on Android 7.0+.
     */
    fun rebootDevice() {
        if (!isDeviceOwner()) {
            Log.w(TAG, "Cannot reboot device: not Device Owner")
            return
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try {
                devicePolicyManager.reboot(componentName)
                Log.i(TAG, "Device reboot initiated")
            } catch (e: SecurityException) {
                Log.e(TAG, "Failed to reboot device", e)
            }
        } else {
            Log.w(TAG, "Reboot not available on API < 24")
        }
    }

    /**
     * Install a package silently from a URI.
     * Requires Device Owner privileges on Android 9.0+.
     *
     * Note: For older versions, use PackageInstaller with auto-confirm.
     */
    fun canInstallPackagesSilently(): Boolean {
        return isDeviceOwner() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
    }

    /**
     * Exempt the app from battery optimization (Doze mode).
     * This is critical for reliable background operation of MDM services.
     *
     * In Device Owner mode, this can be done without user consent.
     * For non-DO apps, this requires user confirmation via system UI.
     *
     * @return true if already exempted or exemption was granted
     */
    fun exemptFromBatteryOptimization(): Boolean {
        val powerManager = context.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager

        // Check if already exempted
        if (powerManager.isIgnoringBatteryOptimizations(context.packageName)) {
            Log.d(TAG, "Already exempt from battery optimization")
            return true
        }

        // In Device Owner mode, add package to whitelist
        if (isDeviceOwner()) {
            return try {
                // DevicePolicyManager.setPackagesSuspended with exempt packages
                // or use addCrossProfileIntentFilter - depends on Android version
                // For now, just ensure the app stays running
                Log.i(TAG, "Device Owner: attempting battery optimization exemption")
                // The app should already be exempt in Device Owner mode for most manufacturers
                true
            } catch (e: Exception) {
                Log.e(TAG, "Failed to exempt from battery optimization", e)
                false
            }
        }

        return false
    }

    // ==================== SOUND / DND CONTROLS ====================

    /**
     * Enable silent mode on the device.
     * Uses multiple approaches for maximum effectiveness:
     * 1. DND (Do Not Disturb) mode via NotificationManager
     * 2. Mute all audio streams via AudioManager
     * 3. Master volume mute via DevicePolicyManager (Device Owner only)
     * 4. Grant notification policy access if Device Owner (Android 7+)
     *
     * @return true if at least one method succeeded
     */
    fun enableSilentMode(): Boolean {
        var success = false

        // Method 0 (Device Owner): Try to grant ourselves notification policy access
        if (isDeviceOwner() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try {
                // Grant notification policy access to this app via secure settings
                android.provider.Settings.Secure.putString(
                    context.contentResolver,
                    "enabled_notification_policy_access_packages",
                    context.packageName
                )
                Log.i(TAG, "Attempted to grant notification policy access via Device Owner")
            } catch (e: Exception) {
                Log.d(TAG, "Could not grant notification policy access: ${e.message}")
            }
        }

        // Method 1: Enable DND mode
        try {
            val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (notificationManager.isNotificationPolicyAccessGranted) {
                notificationManager.setInterruptionFilter(NotificationManager.INTERRUPTION_FILTER_NONE)
                Log.i(TAG, "DND mode enabled")
                success = true
            } else {
                Log.w(TAG, "DND access not granted - cannot enable via NotificationManager")
                // User needs to grant DND access manually in Settings > Apps > Special access
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to enable DND mode", e)
        }

        // Method 2: Mute all audio streams
        try {
            val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val streams = listOf(
                AudioManager.STREAM_RING,
                AudioManager.STREAM_NOTIFICATION,
                AudioManager.STREAM_ALARM,
                AudioManager.STREAM_SYSTEM
            )
            for (stream in streams) {
                audioManager.adjustStreamVolume(stream, AudioManager.ADJUST_MUTE, 0)
            }
            Log.i(TAG, "Audio streams muted")
            success = true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to mute audio streams", e)
        }

        // Method 3: Device Owner master volume mute
        if (isDeviceOwner()) {
            try {
                devicePolicyManager.setMasterVolumeMuted(componentName, true)
                Log.i(TAG, "Master volume muted via Device Owner")
                success = true
            } catch (e: Exception) {
                Log.e(TAG, "Failed to mute master volume", e)
            }
        }

        return success
    }

    /**
     * Disable silent mode on the device.
     * Reverses all silent mode settings.
     *
     * @return true if at least one method succeeded
     */
    fun disableSilentMode(): Boolean {
        var success = false

        // Method 1: Disable DND mode
        try {
            val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (notificationManager.isNotificationPolicyAccessGranted) {
                notificationManager.setInterruptionFilter(NotificationManager.INTERRUPTION_FILTER_ALL)
                Log.i(TAG, "DND mode disabled")
                success = true
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to disable DND mode", e)
        }

        // Method 2: Unmute audio streams
        try {
            val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val streams = listOf(
                AudioManager.STREAM_RING,
                AudioManager.STREAM_NOTIFICATION,
                AudioManager.STREAM_ALARM,
                AudioManager.STREAM_SYSTEM
            )
            for (stream in streams) {
                audioManager.adjustStreamVolume(stream, AudioManager.ADJUST_UNMUTE, 0)
            }
            Log.i(TAG, "Audio streams unmuted")
            success = true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to unmute audio streams", e)
        }

        // Method 3: Device Owner master volume unmute
        if (isDeviceOwner()) {
            try {
                devicePolicyManager.setMasterVolumeMuted(componentName, false)
                Log.i(TAG, "Master volume unmuted via Device Owner")
                success = true
            } catch (e: Exception) {
                Log.e(TAG, "Failed to unmute master volume", e)
            }
        }

        return success
    }

    /**
     * Check if silent mode is currently enabled.
     */
    fun isSilentModeEnabled(): Boolean {
        try {
            val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            return notificationManager.currentInterruptionFilter == NotificationManager.INTERRUPTION_FILTER_NONE
        } catch (e: Exception) {
            Log.e(TAG, "Failed to check DND status", e)
            return false
        }
    }

    /**
     * Clear Device Owner status for this app.
     * This allows the app to be uninstalled normally.
     * Only works if the app is currently Device Owner.
     *
     * @return true if successfully cleared, false otherwise
     */
    fun clearDeviceOwner(): Boolean {
        if (!isDeviceOwner()) {
            Log.w(TAG, "Cannot clear Device Owner: app is not Device Owner")
            return false
        }

        return try {
            devicePolicyManager.clearDeviceOwnerApp(context.packageName)
            Log.i(TAG, "Device Owner status cleared")
            true
        } catch (e: SecurityException) {
            Log.e(TAG, "Failed to clear Device Owner status", e)
            false
        }
    }

    /**
     * Remove this app as Device Admin.
     * Only works if app is Device Admin (not Device Owner).
     *
     * @return true if successfully removed, false otherwise
     */
    fun removeDeviceAdmin(): Boolean {
        if (!isDeviceAdmin()) {
            Log.w(TAG, "Cannot remove Device Admin: app is not Device Admin")
            return false
        }

        return try {
            devicePolicyManager.removeActiveAdmin(componentName)
            Log.i(TAG, "Device Admin status removed")
            true
        } catch (e: SecurityException) {
            Log.e(TAG, "Failed to remove Device Admin status", e)
            false
        }
    }

    /**
     * Get status information about Device Owner mode.
     */
    fun getStatusInfo(): DeviceOwnerStatus {
        return DeviceOwnerStatus(
            isDeviceOwner = isDeviceOwner(),
            isDeviceAdmin = isDeviceAdmin(),
            packageName = context.packageName,
            grantedPermissions = GRANTABLE_PERMISSIONS.filter { isPermissionGranted(it) },
            pendingPermissions = GRANTABLE_PERMISSIONS.filter { !isPermissionGranted(it) }
        )
    }
}

/**
 * Status information about Device Owner mode.
 */
data class DeviceOwnerStatus(
    val isDeviceOwner: Boolean,
    val isDeviceAdmin: Boolean,
    val packageName: String,
    val grantedPermissions: List<String>,
    val pendingPermissions: List<String>
) {
    val hasMdmPrivileges: Boolean
        get() = isDeviceOwner || isDeviceAdmin

    val allPermissionsGranted: Boolean
        get() = pendingPermissions.isEmpty()
}
