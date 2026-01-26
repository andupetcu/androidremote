package com.androidremote.app.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.core.content.ContextCompat

/**
 * Helper for checking required permissions.
 */
class PermissionHelper(private val context: Context) {

    /**
     * Check if InputInjectionService is enabled in accessibility settings.
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
     * Check if all required permissions are granted.
     */
    fun hasAllRequiredPermissions(): Boolean {
        return isAccessibilityServiceEnabled() && hasNotificationPermission()
    }
}
