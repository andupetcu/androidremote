package com.androidremote.app.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Binder
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.androidremote.app.MainActivity
import com.androidremote.app.controller.InputHandler
import com.androidremote.app.controller.SessionController
import com.androidremote.app.controller.TextInputHandler
import com.androidremote.feature.input.AccessibilityNode
import com.androidremote.feature.input.AccessibilityServiceProvider
import com.androidremote.feature.input.ClipboardProvider
import com.androidremote.feature.input.KeyAction
import com.androidremote.feature.input.TextInputService
import com.androidremote.transport.DeviceCommandChannel
import com.androidremote.transport.RemoteSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

/**
 * Foreground service that owns the SessionController.
 *
 * Activities bind to this service to access the session controller.
 * The service runs in foreground with a persistent notification while active.
 */
class RemoteSessionService : Service() {

    companion object {
        private const val NOTIFICATION_ID = 1001
        private const val CHANNEL_ID = "remote_session_channel"

        fun startService(context: Context) {
            val intent = Intent(context, RemoteSessionService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stopService(context: Context) {
            context.stopService(Intent(context, RemoteSessionService::class.java))
        }
    }

    private val binder = LocalBinder()
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var sessionController: SessionController

    inner class LocalBinder : Binder() {
        fun getController(): SessionController = sessionController
    }

    override fun onCreate() {
        super.onCreate()
        sessionController = createSessionController()
        createNotificationChannel()
    }

    override fun onBind(intent: Intent): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Handle stop action from notification
        if (intent?.action == "STOP") {
            sessionController.disconnect()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        val notification = createNotification()
        startForeground(NOTIFICATION_ID, notification)
        return START_STICKY
    }

    override fun onDestroy() {
        sessionController.disconnect()
        serviceScope.cancel()
        super.onDestroy()
    }

    private fun createSessionController(): SessionController {
        val inputHandler = InputHandler()

        // Create stub providers - will be connected to real implementations later
        val accessibilityServiceProvider = object : AccessibilityServiceProvider {
            override fun getFocusedNode(): AccessibilityNode? = null
            override fun setText(text: String): Boolean = false
            override fun performPaste(): Boolean = false
            override fun sendKeyAction(action: KeyAction): Boolean = false
        }
        val clipboardProvider = object : ClipboardProvider {
            override fun getText(): String? = null
            override fun setText(text: String) {}
        }

        val textInputService = TextInputService(accessibilityServiceProvider, clipboardProvider)
        val textInputHandler = TextInputHandler(textInputService)

        return SessionController(
            inputHandler = inputHandler,
            textInputHandler = textInputHandler,
            sessionFactory = { createRemoteSession() },
            commandChannelFactory = { createCommandChannel() },
            scope = serviceScope
        )
    }

    private fun createRemoteSession(): RemoteSession {
        // Placeholder - will be properly implemented with WebRTC integration
        throw NotImplementedError("RemoteSession creation requires WebRTC setup")
    }

    private fun createCommandChannel(): DeviceCommandChannel {
        // Placeholder - will be properly implemented with signaling integration
        throw NotImplementedError("DeviceCommandChannel creation requires signaling setup")
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Remote Control Session",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Shows when remote control is active"
                setShowBadge(false)
            }

            val notificationManager = getSystemService(NotificationManager::class.java)
            notificationManager.createNotificationChannel(channel)
        }
    }

    private fun createNotification(): Notification {
        val openIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, openIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val stopIntent = Intent(this, RemoteSessionService::class.java).apply {
            action = "STOP"
        }
        val stopPendingIntent = PendingIntent.getService(
            this, 0, stopIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Remote Control Active")
            .setContentText("Screen is being shared")
            .setSmallIcon(android.R.drawable.ic_menu_share)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .addAction(android.R.drawable.ic_media_pause, "Stop", stopPendingIntent)
            .build()
    }
}
