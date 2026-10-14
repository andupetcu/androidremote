package com.androidremote.app.mdm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.androidremote.app.admin.DeviceOwnerManager
import com.androidremote.app.kiosk.BootApps
import com.androidremote.app.kiosk.BootPlan
import com.androidremote.app.kiosk.BootStep
import com.androidremote.app.kiosk.KioskController
import com.androidremote.app.ui.SessionStorage
import kotlin.concurrent.thread

/**
 * The only boot receiver (AM-10). The order of work comes from [BootPlan].
 *
 * - LOCKED_BOOT_COMPLETED (direct boot, before the first unlock): only the kiosk target is
 *   started, from device-protected storage. Everything else is encrypted until unlock.
 * - BOOT_COMPLETED: start the polling service, re-apply silent mode, launch the boot apps, and
 *   launch the foreground/kiosk app last so it ends up in front.
 *
 * RemoteSessionService is not started here; START_REMOTE starts it on demand (a mediaProjection
 * foreground service cannot be started from a boot receiver on Android 15).
 * MainActivity is not started either, so it cannot cover the kiosk.
 */
class BootReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "BootReceiver"
        private const val BOOT_DELAY_MS = 8000L
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action != BootPlan.BOOT && action != BootPlan.LOCKED_BOOT) return
        Log.i(TAG, "Received $action")

        val owner = DeviceOwnerManager(context)
        val kiosk = KioskController(context, owner)

        if (action == BootPlan.LOCKED_BOOT) {
            val steps = BootPlan.stepsFor(action, false, false, kiosk.config() != null, false, false)
            if (BootStep.LAUNCH_FOREGROUND in steps) kiosk.config()?.let { kiosk.launch(it.packageName) }
            return
        }

        val storage = SessionStorage.create(context)
        val bootApps = BootApps(context.getSharedPreferences(BootApps.PREFS, Context.MODE_PRIVATE)).all()
        val silent = context.getSharedPreferences("mdm_settings", Context.MODE_PRIVATE).getBoolean("silent_mode", false)
        val steps = BootPlan.stepsFor(
            action,
            enrolled = storage.isEnrolled() && storage.getServerUrl() != null && storage.getDeviceId() != null,
            silentMode = silent && owner.isDeviceOwner(),
            kioskConfigured = kiosk.config() != null,
            hasBootApps = bootApps.values.any { !it },
            hasForeground = bootApps.values.any { it }
        )
        Log.i(TAG, "Boot steps: $steps")

        if (BootStep.START_POLLING in steps) {
            try {
                CommandPollingService.startService(context, pollIntervalMs = 5000L)
            } catch (e: Exception) {
                Log.e(TAG, "Could not start polling service", e)
            }
        }
        if (BootStep.APPLY_SILENT_MODE in steps) {
            try { owner.enableSilentMode() } catch (e: Exception) { Log.e(TAG, "Silent mode failed", e) }
        }
        // Pre-start the root screen server so the first viewer does not wait (AR-07). Non-fatal.
        thread {
            try {
                kotlinx.coroutines.runBlocking { com.androidremote.app.service.ScreenServerManager(context).prestart(restart = false) }
            } catch (e: Exception) {
                Log.w(TAG, "Screen server prestart failed: ${e.message}")
            }
        }
        val launches = steps.filter { it == BootStep.LAUNCH_BOOT_APPS || it == BootStep.LAUNCH_FOREGROUND }
        if (launches.isEmpty()) return

        // Give the package manager time to settle. goAsync keeps the receiver alive for the delay.
        val pending = goAsync()
        thread {
            try {
                Thread.sleep(BOOT_DELAY_MS)
                for (step in launches) {
                    when (step) {
                        BootStep.LAUNCH_BOOT_APPS ->
                            bootApps.filterValues { !it }.keys.forEach { launchWithRetry(kiosk, it) }
                        BootStep.LAUNCH_FOREGROUND ->
                            kiosk.target()?.let { launchWithRetry(kiosk, it) }
                        else -> Unit
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Boot launch failed", e)
            } finally {
                pending.finish()
            }
        }
    }

    private fun launchWithRetry(kiosk: KioskController, pkg: String) {
        repeat(3) { attempt ->
            if (kiosk.launch(pkg)) return
            Log.w(TAG, "Launch of $pkg failed (attempt ${attempt + 1}/3)")
            Thread.sleep(1000)
        }
    }
}
