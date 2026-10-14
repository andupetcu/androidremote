package com.androidremote.app.mdm

import android.content.Context
import android.util.Log
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.androidremote.app.ui.SessionStorage
import java.util.concurrent.TimeUnit

/**
 * WorkManager backstop (15 min, the platform minimum) that restarts [CommandPollingService]
 * when the system has killed it and nothing else brought it back.
 */
object PollingWatchdog {
    const val PERIOD_MINUTES = 15L
    private const val WORK_NAME = "command_polling_watchdog"

    fun shouldRestart(enrolled: Boolean, enrollmentInvalid: Boolean, serviceRunning: Boolean): Boolean =
        enrolled && !enrollmentInvalid && !serviceRunning

    fun schedule(context: Context) {
        try {
            val request = PeriodicWorkRequestBuilder<PollingWatchdogWorker>(PERIOD_MINUTES, TimeUnit.MINUTES).build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request
            )
        } catch (e: Exception) {
            Log.w("PollingWatchdog", "Could not schedule watchdog: ${e.message}")
        }
    }

    fun cancel(context: Context) {
        try {
            WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
        } catch (e: Exception) {
            Log.w("PollingWatchdog", "Could not cancel watchdog: ${e.message}")
        }
    }
}

class PollingWatchdogWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val storage = SessionStorage.create(applicationContext)
        val enrolled = storage.getDeviceId() != null && storage.getServerUrl() != null
        val invalid = EnrollmentState.isInvalid(applicationContext)
        val running = CommandPollingService.isRunning
        if (PollingWatchdog.shouldRestart(enrolled, invalid, running)) {
            Log.w("PollingWatchdog", "Polling service was dead; restarting")
            try {
                CommandPollingService.startService(applicationContext)
            } catch (e: Exception) {
                Log.e("PollingWatchdog", "Restart failed: ${e.message}")
            }
        }
        return Result.success()
    }
}

/** Persisted flag set when the server answers 401/404 to a poll. UI code can read it. */
object EnrollmentState {
    private const val PREFS = "mdm_settings"
    private const val KEY = "enrollment_invalid"

    fun isInvalid(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY, false)

    fun reason(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("enrollment_invalid_reason", null)

    fun markInvalid(context: Context, reason: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean(KEY, true).putString("enrollment_invalid_reason", reason).apply()
    }

    fun clear(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .remove(KEY).remove("enrollment_invalid_reason").apply()
    }
}
