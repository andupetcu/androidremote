package com.androidremote.app.mdm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.util.Log
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * BroadcastReceiver that captures PackageInstaller results.
 *
 * This receiver is used by SilentPackageInstaller to get asynchronous
 * results from installation and uninstallation operations.
 *
 * Must be registered in AndroidManifest.xml:
 * ```xml
 * <receiver
 *     android:name=".mdm.InstallResultReceiver"
 *     android:exported="false" />
 * ```
 */
class InstallResultReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "InstallResultReceiver"

        const val ACTION_INSTALL_RESULT = "com.androidremote.app.INSTALL_RESULT"
        const val ACTION_UNINSTALL_RESULT = "com.androidremote.app.UNINSTALL_RESULT"
        const val EXTRA_CALLBACK_ID = "callback_id"
        const val EXTRA_PACKAGE_NAME = "package_name"

        // Callback registry
        private val callbackIdCounter = AtomicLong(0)
        private val callbacks = ConcurrentHashMap<Long, InstallCallback>()

        /**
         * Register a callback to receive installation result.
         *
         * @param packageName Package being installed (for logging)
         * @param callback Function to call with (status, message)
         * @return Callback ID to include in the PendingIntent
         */
        fun registerCallback(
            packageName: String,
            callback: (status: Int, message: String?) -> Unit
        ): Long {
            val id = callbackIdCounter.incrementAndGet()
            callbacks[id] = InstallCallback(packageName, callback)
            Log.d(TAG, "Registered callback $id for package: $packageName")
            return id
        }

        /**
         * Unregister a callback (e.g., on cancellation).
         */
        fun unregisterCallback(callbackId: Long) {
            callbacks.remove(callbackId)
            Log.d(TAG, "Unregistered callback: $callbackId")
        }

        /**
         * Get the number of pending callbacks (for testing/debugging).
         */
        fun pendingCallbackCount(): Int = callbacks.size
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        val callbackId = intent.getLongExtra(EXTRA_CALLBACK_ID, -1)
        val packageName = intent.getStringExtra(EXTRA_PACKAGE_NAME) ?: "unknown"

        Log.d(TAG, "Received: action=$action, callbackId=$callbackId, package=$packageName")

        when (action) {
            ACTION_INSTALL_RESULT, ACTION_UNINSTALL_RESULT -> {
                handlePackageInstallerResult(intent, callbackId, packageName)
            }
            else -> {
                Log.w(TAG, "Unknown action: $action")
            }
        }
    }

    private fun handlePackageInstallerResult(intent: Intent, callbackId: Long, packageName: String) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)

        Log.i(TAG, "Install result for $packageName: status=$status, message=$message")

        // STATUS_PENDING_USER_ACTION is passed on to the callback like any other status. The installer
        // reports it as a failed result and abandons the session, so the caller never waits forever
        // for a dialog nobody will answer (AM-03, AM-21).
        // Invoke the registered callback
        val callback = callbacks.remove(callbackId)
        if (callback != null) {
            Log.d(TAG, "Invoking callback $callbackId for $packageName")
            callback.callback(status, message)
        } else {
            Log.w(TAG, "No callback found for ID: $callbackId")
        }
    }
}

/**
 * Internal data class for callback storage.
 */
private data class InstallCallback(
    val packageName: String,
    val callback: (status: Int, message: String?) -> Unit
)
