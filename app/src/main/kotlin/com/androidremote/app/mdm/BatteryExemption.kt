package com.androidremote.app.mdm

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import com.androidremote.app.admin.DeviceOwnerManager
import com.androidremote.app.admin.DeviceOwnerReceiver

/**
 * Asks for the battery-optimisation exemption that keeps the polling service alive in Doze (AM-11).
 *
 * As Device Owner the app grants itself REQUEST_IGNORE_BATTERY_OPTIMIZATIONS and then opens the
 * system request. Android has no API to whitelist silently, so on some devices the system dialog
 * still needs one tap; the WorkManager watchdog covers the time until that is done.
 */
object BatteryExemption {
    private const val TAG = "BatteryExemption"
    private const val PERMISSION = "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"

    enum class Plan { NONE, REQUEST }

    fun plan(alreadyExempt: Boolean, isDeviceOwner: Boolean): Plan =
        if (alreadyExempt || !isDeviceOwner) Plan.NONE else Plan.REQUEST

    fun requestIfDeviceOwner(context: Context, deviceOwnerManager: DeviceOwnerManager) {
        try {
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            val exempt = pm.isIgnoringBatteryOptimizations(context.packageName)
            if (plan(exempt, deviceOwnerManager.isDeviceOwner()) == Plan.NONE) return

            val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
            val admin = DeviceOwnerReceiver.getComponentName(context)
            val granted = dpm.setPermissionGrantState(
                admin, context.packageName, PERMISSION, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED
            )
            Log.i(TAG, "Granted $PERMISSION to self: $granted")

            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:${context.packageName}")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
        } catch (e: Exception) {
            Log.w(TAG, "Battery exemption request failed: ${e.message}")
        }
    }
}
