package com.androidremote.app.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.androidremote.app.ScreenCaptureRequestActivity

/**
 * Asks a human for screen-capture consent on devices that cannot use the root screen-server (AR-07).
 *
 * Background services cannot open the MediaProjection dialog on Android 10+, so this posts a
 * high-priority notification with a "Start now" action that opens [ScreenCaptureRequestActivity].
 * The result is broadcast back to the session service (ACTION_SCREEN_CAPTURE_RESULT), which
 * starts MediaProjection capture. Until then the session reports CAPTURE_FAILED("consent_required").
 *
 * Start with [promptIntent]; the service posts the notification and stops itself. It is not a
 * foreground service: a mediaProjection foreground type is only allowed after consent was granted.
 */
class ScreenCaptureService : Service() {

    companion object {
        private const val TAG = "ScreenCaptureService"
        const val ACTION_PROMPT = "com.androidremote.app.action.PROMPT_SCREEN_CAPTURE_CONSENT"
        const val ACTION_CANCEL = "com.androidremote.app.action.CANCEL_SCREEN_CAPTURE_PROMPT"
        private const val CHANNEL_ID = "screen_capture_consent"
        private const val NOTIFICATION_ID = 4107

        fun promptIntent(context: Context): Intent =
            Intent(context, ScreenCaptureService::class.java).setAction(ACTION_PROMPT)

        fun cancelIntent(context: Context): Intent =
            Intent(context, ScreenCaptureService::class.java).setAction(ACTION_CANCEL)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        when (intent?.action) {
            ACTION_PROMPT -> {
                postPrompt(nm)
                // Works when the app is already visible; otherwise the notification is the way in.
                try {
                    startActivity(ScreenCaptureRequestActivity.createIntent(this))
                } catch (e: Exception) {
                    Log.i(TAG, "Direct consent launch blocked, relying on notification: ${e.message}")
                }
            }
            ACTION_CANCEL -> nm.cancel(NOTIFICATION_ID)
        }
        stopSelf(startId)
        return START_NOT_STICKY
    }

    private fun postPrompt(nm: NotificationManager) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Screen sharing request", NotificationManager.IMPORTANCE_HIGH)
            )
        }
        val open = PendingIntent.getActivity(
            this, 0, ScreenCaptureRequestActivity.createIntent(this),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentTitle("Remote screen sharing requested")
            .setContentText("Tap Start now to let the operator see this screen")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setContentIntent(open)
            .setFullScreenIntent(open, true)
            .addAction(0, "Start now", open)
            .setAutoCancel(true)
            .build()
        nm.notify(NOTIFICATION_ID, notification)
    }
}
