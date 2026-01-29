package com.androidremote.app.mdm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.androidremote.app.MainActivity
import com.androidremote.app.admin.DeviceOwnerManager
import kotlin.concurrent.thread

/**
 * Boot receiver to auto-start apps configured in policy.
 *
 * Boot sequence:
 * 1. Start Android Remote (MainActivity) first - establishes MDM control
 * 2. Wait 5 seconds for system to stabilize
 * 3. Start regular boot-start apps
 * 4. Start foreground app last so it stays on top
 *
 * Apps can be configured with:
 * - autoStartOnBoot: Start the app when device boots
 * - foregroundApp: This is the primary app, should be in foreground
 *
 * Preferences are stored via CommandPollingService.saveBootStartApp()
 * Format: SharedPreferences "boot_apps" with packageName -> Boolean (true = foreground)
 *
 * IMPORTANT: Uses goAsync() to keep the receiver alive during the delay.
 * Handler.postDelayed doesn't work in BroadcastReceivers because the process
 * can be killed after onReceive returns.
 */
class BootReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "BootReceiver"
        private const val PREFS_NAME = "boot_apps"
        private const val BOOT_DELAY_MS = 8000L  // 8 seconds delay before launching policy apps
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) {
            return
        }

        Log.i(TAG, "Boot completed - starting Android Remote MDM")

        // Apply silent mode if device is managed
        applySilentModeIfNeeded(context)

        // Step 1: Start Android Remote app first (establishes MDM control)
        startAndroidRemote(context)

        // Step 2: Use goAsync() to keep receiver alive during the delay
        // Handler.postDelayed doesn't work because the receiver can be killed after onReceive returns
        val pendingResult = goAsync()

        thread {
            try {
                Log.i(TAG, "Waiting ${BOOT_DELAY_MS}ms before launching policy apps...")
                Thread.sleep(BOOT_DELAY_MS)

                // Launch apps on main thread
                Handler(Looper.getMainLooper()).post {
                    launchPolicyApps(context)
                    pendingResult.finish()
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error in boot delay thread", e)
                pendingResult.finish()
            }
        }
    }

    /**
     * Start the Android Remote app (MainActivity) first.
     * This establishes MDM control and starts the command polling service.
     */
    private fun startAndroidRemote(context: Context) {
        try {
            val intent = Intent(context, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            Log.i(TAG, "Started Android Remote app")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start Android Remote app", e)
        }
    }

    /**
     * Launch apps configured in policy after the delay.
     */
    private fun launchPolicyApps(context: Context) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val allApps = prefs.all

        if (allApps.isEmpty()) {
            Log.d(TAG, "No boot-start apps configured")
            return
        }

        // Separate foreground app from regular boot-start apps
        var foregroundApp: String? = null
        val regularApps = mutableListOf<String>()

        for ((packageName, value) in allApps) {
            val isForeground = value as? Boolean ?: false
            if (isForeground) {
                foregroundApp = packageName
            } else {
                regularApps.add(packageName)
            }
        }

        Log.d(TAG, "Boot-start apps: $regularApps, foreground: $foregroundApp")

        // Launch regular apps first
        for (packageName in regularApps) {
            launchApp(context, packageName, false)
        }

        // Launch foreground app last so it stays in front
        if (foregroundApp != null) {
            launchApp(context, foregroundApp, true)
        }
    }

    /**
     * Apply silent mode if the device is in Device Owner mode.
     * This ensures the device remains silent after reboots.
     */
    private fun applySilentModeIfNeeded(context: Context) {
        try {
            val deviceOwnerManager = DeviceOwnerManager(context)
            if (deviceOwnerManager.isDeviceOwner()) {
                // Check if silent mode was previously enabled
                val mdmPrefs = context.getSharedPreferences("mdm_settings", Context.MODE_PRIVATE)
                val silentModeEnabled = mdmPrefs.getBoolean("silent_mode", false)

                if (silentModeEnabled) {
                    deviceOwnerManager.enableSilentMode()
                    Log.i(TAG, "Re-applied silent mode after boot")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to apply silent mode on boot", e)
        }
    }

    private fun launchApp(context: Context, packageName: String, bringToFront: Boolean) {
        // Retry logic - package manager may not be ready immediately after boot
        for (attempt in 1..3) {
            try {
                var launchIntent = context.packageManager.getLaunchIntentForPackage(packageName)

                // Fallback: query MAIN/LAUNCHER activity directly
                if (launchIntent == null) {
                    Log.d(TAG, "getLaunchIntentForPackage returned null, trying queryIntentActivities")
                    val queryIntent = Intent(Intent.ACTION_MAIN).apply {
                        addCategory(Intent.CATEGORY_LAUNCHER)
                        setPackage(packageName)
                    }
                    val activities = context.packageManager.queryIntentActivities(queryIntent, 0)
                    if (activities.isNotEmpty()) {
                        val activityInfo = activities[0].activityInfo
                        launchIntent = Intent(Intent.ACTION_MAIN).apply {
                            addCategory(Intent.CATEGORY_LAUNCHER)
                            setClassName(activityInfo.packageName, activityInfo.name)
                        }
                        Log.d(TAG, "Found activity via query: ${activityInfo.name}")
                    }
                }

                if (launchIntent != null) {
                    launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    if (bringToFront) {
                        // Use all flags to ensure app comes to foreground
                        launchIntent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
                        launchIntent.addFlags(Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
                        launchIntent.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                        launchIntent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    }
                    context.startActivity(launchIntent)
                    Log.i(TAG, "Launched app: $packageName (foreground: $bringToFront)")
                    return
                } else {
                    Log.w(TAG, "No launch intent for package: $packageName (attempt $attempt/3)")
                    if (attempt < 3) {
                        Thread.sleep(1000)
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to launch app: $packageName (attempt $attempt/3)", e)
                if (attempt < 3) {
                    Thread.sleep(1000)
                }
            }
        }
        Log.e(TAG, "Failed to launch app after 3 attempts: $packageName")
    }
}
