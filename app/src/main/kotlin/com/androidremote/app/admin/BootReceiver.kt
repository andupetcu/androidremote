package com.androidremote.app.admin

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.androidremote.app.mdm.CommandPollingService
import com.androidremote.app.service.RemoteSessionService
import com.androidremote.app.ui.SessionStorage

/**
 * Boot receiver for auto-starting the remote session service.
 *
 * When the device boots and the app is in Device Owner mode with an active session,
 * this receiver will automatically start the RemoteSessionService to resume
 * the MDM connection.
 */
class BootReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "BootReceiver"
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) {
            return
        }

        Log.i(TAG, "Boot completed - checking for auto-start")

        val deviceOwnerManager = DeviceOwnerManager(context)
        val sessionStorage = SessionStorage.create(context)

        // Only auto-start if we're in Device Owner/Admin mode
        if (!deviceOwnerManager.hasMdmPrivileges()) {
            Log.d(TAG, "Not in MDM mode, skipping auto-start")
            return
        }

        // Check if we have a saved session to reconnect
        val serverUrl = sessionStorage.getServerUrl()
        val sessionToken = sessionStorage.getSessionToken()
        val deviceId = sessionStorage.getDeviceId()

        // Start command polling service if enrolled
        if (sessionStorage.isEnrolled() && serverUrl != null && deviceId != null) {
            Log.i(TAG, "Auto-starting command polling service")
            CommandPollingService.startService(context, pollIntervalMs = 5000L)
        }

        // Start remote session service if we have a full session
        if (serverUrl != null && sessionToken != null && deviceId != null) {
            Log.i(TAG, "Auto-starting remote session service")

            // Start the foreground service
            val serviceIntent = Intent(context, RemoteSessionService::class.java).apply {
                putExtra(RemoteSessionService.EXTRA_AUTO_START, true)
                putExtra(RemoteSessionService.EXTRA_SERVER_URL, serverUrl)
                putExtra(RemoteSessionService.EXTRA_SESSION_TOKEN, sessionToken)
                putExtra(RemoteSessionService.EXTRA_DEVICE_ID, deviceId)
            }

            context.startForegroundService(serviceIntent)
        } else {
            Log.d(TAG, "No saved session, skipping remote service auto-start")
        }
    }
}
