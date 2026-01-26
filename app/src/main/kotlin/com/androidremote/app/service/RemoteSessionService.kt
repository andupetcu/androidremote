package com.androidremote.app.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Binder
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.androidremote.app.MainActivity
import com.androidremote.app.controller.InputHandler
import com.androidremote.app.controller.SessionController
import com.androidremote.app.controller.TextInputHandler
import com.androidremote.app.webrtc.WebRtcPeerConnectionFactory
import com.androidremote.feature.input.TextInputService
import com.androidremote.feature.screen.EncoderConfig
import com.androidremote.feature.screen.ScreenCaptureManager
import com.androidremote.transport.DeviceCommandChannel
import com.androidremote.transport.FrameData
import com.androidremote.transport.KtorWebSocketProvider
import com.androidremote.transport.RemoteSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch

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

    // Track resources that need to be disposed
    private var currentPeerConnectionFactory: WebRtcPeerConnectionFactory? = null
    private var currentWebSocketProvider: KtorWebSocketProvider? = null

    // Screen capture resources
    private var screenCaptureManager: ScreenCaptureManager? = null
    private val _frameDataFlow = MutableSharedFlow<FrameData>(replay = 0, extraBufferCapacity = 64)
    private val frameDataFlow: SharedFlow<FrameData> = _frameDataFlow

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
        stopScreenCapture()
        sessionController.disconnect()
        disposeCurrentResources()
        serviceScope.cancel()
        super.onDestroy()
    }

    private fun createSessionController(): SessionController {
        val inputHandler = InputHandler()

        // Create real provider implementations
        val accessibilityServiceProvider = InputInjectionAccessibilityProvider()
        val clipboardProvider = AndroidClipboardProvider(this)

        val textInputService = TextInputService(accessibilityServiceProvider, clipboardProvider)
        val textInputHandler = TextInputHandler(textInputService)

        return SessionController(
            inputHandler = inputHandler,
            textInputHandler = textInputHandler,
            sessionFactory = { serverUrl, sessionToken -> createRemoteSession(serverUrl, sessionToken) },
            commandChannelFactory = { session -> createCommandChannel(session) },
            scope = serviceScope
        )
    }

    /**
     * Creates a RemoteSession with real WebSocket and WebRTC providers.
     *
     * @param serverUrl The signaling server URL
     * @param sessionToken The session authentication token
     * @return A configured RemoteSession ready for connection
     */
    private fun createRemoteSession(serverUrl: String, sessionToken: String): RemoteSession {
        // Dispose any previous resources before creating new ones
        disposeCurrentResources()

        val webSocketProvider = KtorWebSocketProvider()
        val peerConnectionFactory = WebRtcPeerConnectionFactory.createDataChannelOnly(this)

        // Track resources for cleanup
        currentWebSocketProvider = webSocketProvider
        currentPeerConnectionFactory = peerConnectionFactory

        return RemoteSession(
            serverUrl = serverUrl,
            sessionToken = sessionToken,
            webSocketProvider = webSocketProvider,
            peerConnectionFactory = peerConnectionFactory,
            scope = serviceScope,
            createCommandChannel = false // Device mode - we create DeviceCommandChannel instead
        )
    }

    /**
     * Disposes the current WebRTC and WebSocket resources.
     * Call this when session is disconnected or service is destroyed.
     */
    private fun disposeCurrentResources() {
        currentWebSocketProvider?.close()
        currentWebSocketProvider = null

        currentPeerConnectionFactory?.dispose()
        currentPeerConnectionFactory = null
    }

    /**
     * Creates a DeviceCommandChannel from the session's data channel.
     *
     * @param session The RemoteSession to get the data channel from
     * @return A DeviceCommandChannel wrapping the session's data channel
     * @throws IllegalStateException if the data channel is not available
     */
    private fun createCommandChannel(session: RemoteSession): DeviceCommandChannel {
        val dataChannel = session.dataChannelInterface
            ?: throw IllegalStateException("Data channel not available - session may not be fully connected")

        return DeviceCommandChannel(dataChannel)
    }

    /**
     * Start screen capture and stream to connected session.
     *
     * @param resultCode MediaProjection result code from Activity
     * @param data MediaProjection result Intent from Activity
     */
    fun startScreenCapture(resultCode: Int, data: Intent) {
        val projectionManager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val mediaProjection = projectionManager.getMediaProjection(resultCode, data)
            ?: throw IllegalStateException("Failed to get MediaProjection")

        val manager = ScreenCaptureManager(this)
        screenCaptureManager = manager

        val config = EncoderConfig(
            width = 1280,
            height = 720,
            bitrate = 2_000_000,
            frameRate = 30
        )

        manager.start(mediaProjection, config)

        // Collect encoded frames and forward to FrameData flow
        serviceScope.launch {
            manager.encodedFrames.collect { encodedFrame ->
                _frameDataFlow.emit(
                    FrameData(
                        data = encodedFrame.data,
                        presentationTimeUs = encodedFrame.presentationTimeUs,
                        isKeyFrame = encodedFrame.isKeyFrame
                    )
                )
            }
        }

        // Start video streaming to session
        sessionController.startVideoStream(frameDataFlow)
    }

    /**
     * Stop screen capture and streaming.
     */
    fun stopScreenCapture() {
        sessionController.stopVideoStream()
        screenCaptureManager?.stop()
        screenCaptureManager = null
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
