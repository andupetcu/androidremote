package com.androidremote.app.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.androidremote.app.admin.DeviceOwnerManager

/**
 * Helper for checking and managing required permissions.
 *
 * In Device Owner mode, most permissions can be auto-granted except AccessibilityService.
 */
class PermissionHelper(private val context: Context) {

    private val deviceOwnerManager: DeviceOwnerManager by lazy {
        DeviceOwnerManager(context)
    }

    /**
     * Check if the app is running in Device Owner mode.
     */
    fun isDeviceOwner(): Boolean {
        return deviceOwnerManager.isDeviceOwner()
    }

    /**
     * Check if the app has MDM privileges (Device Owner or Admin).
     */
    fun hasMdmPrivileges(): Boolean {
        return deviceOwnerManager.hasMdmPrivileges()
    }

    /**
     * Check if InputInjectionService is enabled in accessibility settings.
     *
     * NOTE: This cannot be auto-enabled even in Device Owner mode.
     * User must manually enable it in Settings > Accessibility.
     */
    fun isAccessibilityServiceEnabled(): Boolean {
        val enabledServices = Settings.Secure.getString(
            context.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false

        val serviceName = "${context.packageName}/.service.InputInjectionService"
        val flatServiceName = "${context.packageName}/com.androidremote.app.service.InputInjectionService"

        return enabledServices.contains(serviceName) || enabledServices.contains(flatServiceName)
    }

    /**
     * Check if POST_NOTIFICATIONS permission is granted (Android 13+).
     */
    fun hasNotificationPermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
        } else {
            true // Not required before Android 13
        }
    }

    /**
     * Check if CAMERA permission is granted.
     */
    fun hasCameraPermission(): Boolean {
        return ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.CAMERA
        ) == PackageManager.PERMISSION_GRANTED
    }

    /**
     * Check if location permission is granted.
     */
    fun hasLocationPermission(): Boolean {
        return ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
    }

    /**
     * Check if the app is exempt from battery optimization (Doze mode).
     * This is critical for background services to run reliably.
     */
    fun isBatteryOptimizationDisabled(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            return powerManager.isIgnoringBatteryOptimizations(context.packageName)
        }
        return true // Not needed before Android 6.0
    }

    /**
     * Check if all required permissions are granted.
     * For MDM operation we need:
     * - Notification permission (for foreground service)
     * - Battery optimization disabled (for reliable background operation)
     * - Accessibility service (for input injection - optional for basic MDM)
     */
    fun hasAllRequiredPermissions(): Boolean {
        return hasNotificationPermission() && isBatteryOptimizationDisabled()
    }

    /**
     * Check if all permissions for full functionality are granted.
     */
    fun hasAllOptionalPermissions(): Boolean {
        return hasLocationPermission() && hasCameraPermission()
    }

    /**
     * Auto-grant all grantable permissions if in Device Owner mode.
     * AccessibilityService still requires manual setup.
     *
     * @return true if permissions were granted, false if not Device Owner
     */
    fun autoGrantPermissionsIfDeviceOwner(): Boolean {
        if (!isDeviceOwner()) {
            return false
        }
        return deviceOwnerManager.autoGrantPermissions()
    }

    /**
     * Get a summary of permission states for the UI.
     */
    fun getPermissionSummary(): PermissionSummary {
        return PermissionSummary(
            isDeviceOwner = isDeviceOwner(),
            hasMdmPrivileges = hasMdmPrivileges(),
            accessibilityEnabled = isAccessibilityServiceEnabled(),
            notificationGranted = hasNotificationPermission(),
            cameraGranted = hasCameraPermission(),
            locationGranted = hasLocationPermission(),
            batteryOptimizationDisabled = isBatteryOptimizationDisabled()
        )
    }
}

/**
 * Summary of all permission states.
 */
data class PermissionSummary(
    val isDeviceOwner: Boolean,
    val hasMdmPrivileges: Boolean,
    val accessibilityEnabled: Boolean,
    val notificationGranted: Boolean,
    val cameraGranted: Boolean,
    val locationGranted: Boolean,
    val batteryOptimizationDisabled: Boolean
) {
    /**
     * All runtime permissions (excluding Accessibility) are granted.
     */
    val allRuntimePermissionsGranted: Boolean
        get() = notificationGranted && cameraGranted && locationGranted

    /**
     * Ready for basic MDM operation (commands, background polling).
     * Requires notification permission + battery optimization disabled.
     */
    val isReadyForMdm: Boolean
        get() = notificationGranted && batteryOptimizationDisabled

    /**
     * Ready for remote control operation.
     * Requires AccessibilityService + runtime permissions.
     */
    val isReady: Boolean
        get() = accessibilityEnabled && notificationGranted && batteryOptimizationDisabled

    /**
     * In Device Owner mode, only Accessibility requires manual action.
     */
    val onlyAccessibilityPending: Boolean
        get() = isDeviceOwner && allRuntimePermissionsGranted && !accessibilityEnabled
}
