package com.androidremote.app.admin

import android.app.admin.DeviceAdminReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Device Admin Receiver for MDM functionality.
 *
 * This receiver is required for Device Owner and Device Admin modes.
 * When the app is set as Device Owner, it gains elevated privileges:
 * - Silent permission grants (except Accessibility)
 * - Silent app installation/uninstallation
 * - Lock/wipe device remotely
 * - Configure device policies
 *
 * Setup as Device Owner (requires factory reset or ADB):
 * ```
 * adb shell dpm set-device-owner com.androidremote.app/.admin.DeviceOwnerReceiver
 * ```
 *
 * Setup as Device Admin (user can approve):
 * ```
 * val intent = Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN)
 * intent.putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, DeviceOwnerReceiver.getComponentName(context))
 * startActivity(intent)
 * ```
 */
class DeviceOwnerReceiver : DeviceAdminReceiver() {

    companion object {
        private const val TAG = "DeviceOwnerReceiver"

        /**
         * Get the ComponentName for this receiver.
         * Used when interacting with DevicePolicyManager.
         */
        fun getComponentName(context: Context): ComponentName {
            return ComponentName(context, DeviceOwnerReceiver::class.java)
        }
    }

    override fun onEnabled(context: Context, intent: Intent) {
        super.onEnabled(context, intent)
        Log.i(TAG, "Device admin enabled")
    }

    override fun onDisabled(context: Context, intent: Intent) {
        super.onDisabled(context, intent)
        Log.i(TAG, "Device admin disabled")
    }

    override fun onProfileProvisioningComplete(context: Context, intent: Intent) {
        super.onProfileProvisioningComplete(context, intent)
        Log.i(TAG, "Profile provisioning complete - Device Owner mode activated")

        // Auto-grant required permissions when Device Owner mode is activated
        DeviceOwnerManager(context).autoGrantPermissions()
    }

    override fun onLockTaskModeEntering(context: Context, intent: Intent, pkg: String) {
        super.onLockTaskModeEntering(context, intent, pkg)
        Log.d(TAG, "Entering lock task mode for package: $pkg")
    }

    override fun onLockTaskModeExiting(context: Context, intent: Intent) {
        super.onLockTaskModeExiting(context, intent)
        Log.d(TAG, "Exiting lock task mode")
    }
}
