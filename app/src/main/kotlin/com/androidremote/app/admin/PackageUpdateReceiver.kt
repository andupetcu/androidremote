package com.androidremote.app.admin

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.androidremote.app.mdm.CommandPollingService
import com.androidremote.app.ui.SessionStorage

/**
 * Receiver that auto-restarts services after the app is updated (self-update).
 *
 * When the app installs a new version of itself via INSTALL_APK command,
 * Android kills the old process. This receiver fires on MY_PACKAGE_REPLACED
 * and restarts the MDM services so the device stays connected.
 */
class PackageUpdateReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "PackageUpdateReceiver"
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) {
            return
        }

        Log.i(TAG, "Package updated — restarting services")

        val sessionStorage = SessionStorage.create(context)
        val serverUrl = sessionStorage.getServerUrl()
        val deviceId = sessionStorage.getDeviceId()

        // Restart command polling if enrolled
        if (sessionStorage.isEnrolled() && serverUrl != null && deviceId != null) {
            Log.i(TAG, "Restarting command polling service after update")
            try {
                CommandPollingService.startService(context, pollIntervalMs = 5000L)
            } catch (e: Exception) {
                Log.e(TAG, "Could not restart polling service", e)
            }
        }
        // New app build may ship a new screen server: restart it (rooted devices only, off Main, non-fatal)
        val pending = goAsync()
        kotlin.concurrent.thread {
            try {
                kotlinx.coroutines.runBlocking {
                    com.androidremote.app.service.ScreenServerManager(context).prestart(restart = true)
                }
            } catch (e: Exception) {
                Log.w(TAG, "Screen server prestart failed: ${e.message}")
            } finally {
                pending.finish()
            }
        }
        // RemoteSessionService is not restarted here: a mediaProjection foreground service cannot be
        // started from a background receiver on Android 14/15 (AM-10). START_REMOTE starts it on demand.
    }
}
