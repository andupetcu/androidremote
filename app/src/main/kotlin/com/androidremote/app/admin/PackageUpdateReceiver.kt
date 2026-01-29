package com.androidremote.app.admin

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.androidremote.app.mdm.CommandPollingService
import com.androidremote.app.service.RemoteSessionService
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
        val sessionToken = sessionStorage.getSessionToken()

        // Restart command polling if enrolled
        if (sessionStorage.isEnrolled() && serverUrl != null && deviceId != null) {
            Log.i(TAG, "Restarting command polling service after update")
            CommandPollingService.startService(context, pollIntervalMs = 5000L)
        }

        // Restart remote session if we have a saved session
        if (serverUrl != null && sessionToken != null && deviceId != null) {
            Log.i(TAG, "Restarting remote session service after update")
            val serviceIntent = Intent(context, RemoteSessionService::class.java).apply {
                putExtra(RemoteSessionService.EXTRA_AUTO_START, true)
                putExtra(RemoteSessionService.EXTRA_SERVER_URL, serverUrl)
                putExtra(RemoteSessionService.EXTRA_SESSION_TOKEN, sessionToken)
                putExtra(RemoteSessionService.EXTRA_DEVICE_ID, deviceId)
            }
            context.startForegroundService(serviceIntent)
        }
    }
}
