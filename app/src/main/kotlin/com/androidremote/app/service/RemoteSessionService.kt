package com.androidremote.app.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.projection.MediaProjectionManager
import android.util.Log
import android.os.Binder
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.androidremote.app.MainActivity
import com.androidremote.app.ScreenCaptureRequestActivity
import com.androidremote.app.controller.InputHandler
import com.androidremote.app.controller.MdmHandler
import com.androidremote.app.controller.SessionController
import com.androidremote.app.controller.SessionState
import com.androidremote.app.controller.TextInputHandler
import com.androidremote.app.webrtc.WebRtcPeerConnectionFactory
import com.androidremote.feature.input.TextInputService
import com.androidremote.feature.screen.EncoderConfig
import com.androidremote.feature.screen.ScreenCaptureManager
import com.androidremote.transport.DeviceCommandChannel
import com.androidremote.transport.FrameData
import com.androidremote.transport.KtorWebSocketProvider
import com.androidremote.transport.RemoteSession
import kotlinx.coroutines.CoroutineExceptionHandler
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
        private const val TAG = "RemoteSessionService"
        private const val NOTIFICATION_ID = 1001
        private const val CHANNEL_ID = "remote_session_channel"

        // Intent extras for auto-start from BootReceiver
        const val EXTRA_AUTO_START = "auto_start"
        const val EXTRA_SERVER_URL = "server_url"
        const val EXTRA_SESSION_TOKEN = "session_token"
        const val EXTRA_DEVICE_ID = "device_id"

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
    private val exceptionHandler = CoroutineExceptionHandler { _, throwable ->
        Log.e(TAG, "Uncaught coroutine exception", throwable)
    }
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main + exceptionHandler)
    private lateinit var sessionController: SessionController

    // Track resources that need to be disposed
    private var currentPeerConnectionFactory: WebRtcPeerConnectionFactory? = null
    private var currentWebSocketProvider: KtorWebSocketProvider? = null

    // Screen capture resources (MediaProjection-based - fallback)
    private var screenCaptureManager: ScreenCaptureManager? = null
    private val _frameDataFlow = MutableSharedFlow<FrameData>(replay = 0, extraBufferCapacity = 64)
    private val frameDataFlow: SharedFlow<FrameData> = _frameDataFlow

    // Screen server client (scrcpy-style - preferred)
    private var screenServerClient: ScreenServerClient? = null
    private var screenServerManager: ScreenServerManager? = null

    // Track whether this is an auto-started session (needs automatic screen capture)
    private var isAutoStartedSession = false
    private var isScreenCaptureActive = false
    private var screenCaptureReceiver: BroadcastReceiver? = null

    // Capture mode preference
    private var useScreenServer = true

    // Track the state observer job to cancel on re-entry
    private var stateObserverJob: kotlinx.coroutines.Job? = null

    // Device Owner manager for checking MDM privileges
    private val deviceOwnerManager by lazy {
        com.androidremote.app.admin.DeviceOwnerManager(this)
    }

    inner class LocalBinder : Binder() {
        fun getController(): SessionController = sessionController
    }

    override fun onCreate() {
        super.onCreate()
        sessionController = createSessionController()
        createNotificationChannel()
        registerScreenCaptureReceiver()
    }

    private fun registerScreenCaptureReceiver() {
        screenCaptureReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                if (intent?.action == ScreenCaptureRequestActivity.ACTION_SCREEN_CAPTURE_RESULT) {
                    val resultCode = intent.getIntExtra(ScreenCaptureRequestActivity.EXTRA_RESULT_CODE, 0)
                    val data = intent.getParcelableExtra<Intent>(ScreenCaptureRequestActivity.EXTRA_RESULT_DATA)

                    if (resultCode == android.app.Activity.RESULT_OK && data != null) {
                        Log.i(TAG, "Screen capture permission received, starting capture")
                        startScreenCapture(resultCode, data)
                    } else {
                        Log.w(TAG, "Screen capture permission denied or data missing")
                    }
                }
            }
        }

        val filter = IntentFilter(ScreenCaptureRequestActivity.ACTION_SCREEN_CAPTURE_RESULT)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(screenCaptureReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(screenCaptureReceiver, filter)
        }
    }

    /**
     * Launch the screen capture permission request activity.
     * This shows a system dialog for the user to grant screen capture permission.
     */
    private fun requestScreenCapturePermission() {
        val intent = ScreenCaptureRequestActivity.createIntent(this)
        startActivity(intent)
    }

    override fun onBind(intent: Intent): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.i(TAG, "onStartCommand: action=${intent?.action}, autoStart=${intent?.getBooleanExtra(EXTRA_AUTO_START, false)}")

        // Handle stop action from notification
        if (intent?.action == "STOP") {
            sessionController.disconnect()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        val notification = createNotification()
        startForeground(NOTIFICATION_ID, notification)

        // Handle auto-start from BootReceiver (MDM mode)
        if (intent?.getBooleanExtra(EXTRA_AUTO_START, false) == true) {
            val serverUrl = intent.getStringExtra(EXTRA_SERVER_URL)
            val sessionToken = intent.getStringExtra(EXTRA_SESSION_TOKEN)
            val deviceId = intent.getStringExtra(EXTRA_DEVICE_ID)

            Log.i(TAG, "Auto-start: serverUrl=$serverUrl, deviceId=$deviceId, hasToken=${sessionToken != null}")

            if (serverUrl != null && sessionToken != null && deviceId != null) {
                // Clean up any previous capture state from a prior session
                if (isScreenCaptureActive) {
                    Log.i(TAG, "Cleaning up previous screen capture before new session")
                    stopScreenCapture()
                }

                isAutoStartedSession = true

                // Cancel any previous state observer to avoid leaked collectors
                stateObserverJob?.cancel()

                // Observe session state to manage screen capture lifecycle
                stateObserverJob = serviceScope.launch {
                    sessionController.state.collect { state ->
                        Log.d(TAG, "Session state changed: $state")
                        if (state is SessionState.Connected && isAutoStartedSession && !isScreenCaptureActive) {
                            Log.i(TAG, "Session connected, starting screen capture")
                            isAutoStartedSession = false // Only request once
                            isScreenCaptureActive = true

                            if (useScreenServer) {
                                // Try scrcpy-style screen server first
                                startScreenServerCapture()
                            } else {
                                // Fall back to MediaProjection
                                requestScreenCapturePermission()
                            }
                        } else if (state is SessionState.Disconnected || state is SessionState.Error) {
                            if (isScreenCaptureActive) {
                                Log.i(TAG, "Session disconnected/error, stopping screen capture")
                                stopScreenCapture()
                            }
                        }
                    }
                }

                serviceScope.launch {
                    try {
                        Log.i(TAG, "Calling sessionController.connect($serverUrl, token, $deviceId)")
                        sessionController.connect(serverUrl, sessionToken, deviceId)
                        Log.i(TAG, "sessionController.connect returned")
                    } catch (e: Exception) {
                        Log.e(TAG, "Auto-connect failed", e)
                    }
                }
            } else {
                Log.w(TAG, "Auto-start missing params: serverUrl=$serverUrl, deviceId=$deviceId, hasToken=${sessionToken != null}")
            }
        }

        return START_STICKY
    }

    override fun onDestroy() {
        screenCaptureReceiver?.let {
            try {
                unregisterReceiver(it)
            } catch (e: Exception) {
                Log.w(TAG, "Error unregistering receiver", e)
            }
        }
        screenCaptureReceiver = null
        stopScreenCapture()
        sessionController.disconnect()
        disposeCurrentResources()
        serviceScope.cancel()
        super.onDestroy()
    }

    private fun createSessionController(): SessionController {
        val inputHandler = InputHandler()

        // Initialize coordinate mapper with current screen dimensions
        val displayManager = getSystemService(Context.DISPLAY_SERVICE) as android.hardware.display.DisplayManager
        val defaultDisplay = displayManager.getDisplay(android.view.Display.DEFAULT_DISPLAY)
        val rotation = defaultDisplay?.rotation ?: android.view.Surface.ROTATION_0
        val rotationDegrees = when (rotation) {
            android.view.Surface.ROTATION_90 -> 90
            android.view.Surface.ROTATION_180 -> 180
            android.view.Surface.ROTATION_270 -> 270
            else -> 0
        }

        // Get real screen resolution from DisplayMetrics
        val displayMetrics = android.util.DisplayMetrics()
        @Suppress("DEPRECATION")
        defaultDisplay?.getRealMetrics(displayMetrics)
        val screenWidth = displayMetrics.widthPixels
        val screenHeight = displayMetrics.heightPixels

        Log.i(TAG, "Screen config: ${screenWidth}x${screenHeight}, rotation=${rotationDegrees}°")
        inputHandler.updateScreenConfig(
            width = screenWidth,
            height = screenHeight,
            rotation = rotationDegrees
        )

        // Create real provider implementations
        val accessibilityServiceProvider = InputInjectionAccessibilityProvider()
        val clipboardProvider = AndroidClipboardProvider(this)

        val textInputService = TextInputService(accessibilityServiceProvider, clipboardProvider)
        val textInputHandler = TextInputHandler(textInputService)

        // Create MDM handler for Device Owner features
        val mdmHandler = MdmHandler(this)

        return SessionController(
            inputHandler = inputHandler,
            textInputHandler = textInputHandler,
            mdmHandler = mdmHandler,
            sessionFactory = { serverUrl, deviceId -> createRemoteSession(serverUrl, deviceId) },
            commandChannelFactory = { session -> createCommandChannel(session) },
            scope = serviceScope
        )
    }

    /**
     * Creates a RemoteSession with real WebSocket and WebRTC providers.
     *
     * @param serverUrl The signaling server URL
     * @param deviceId The unique device identifier for the session room
     * @return A configured RemoteSession ready for connection
     */
    private fun createRemoteSession(serverUrl: String, deviceId: String): RemoteSession {
        // Dispose any previous resources before creating new ones
        disposeCurrentResources()

        val webSocketProvider = KtorWebSocketProvider()
        val peerConnectionFactory = WebRtcPeerConnectionFactory.createDataChannelOnly()

        // Track resources for cleanup
        currentWebSocketProvider = webSocketProvider
        currentPeerConnectionFactory = peerConnectionFactory

        return RemoteSession(
            serverUrl = serverUrl,
            deviceId = deviceId,
            webSocketProvider = webSocketProvider,
            peerConnectionFactory = peerConnectionFactory,
            scope = serviceScope,
            createCommandChannel = false // Device mode - we create DeviceCommandChannel instead
        )
    }

    /**
     * Disposes the current WebRTC and WebSocket resources.
     * Call this when session is disconnected or service is destroyed.
     *
     * IMPORTANT: The caller MUST ensure that all PeerConnections created by
     * the factory have been closed BEFORE calling this method. Disposing the
     * factory while native PeerConnections are alive causes SIGSEGV in
     * libjingle_peerconnection_so.so (use-after-free in native WebRTC code).
     *
     * SessionController.performConnect() disconnects the old RemoteSession
     * (which closes the PeerConnection) before calling sessionFactory(),
     * which in turn calls createRemoteSession() -> disposeCurrentResources().
     */
    private fun disposeCurrentResources() {
        currentWebSocketProvider?.close()
        currentWebSocketProvider = null

        try {
            currentPeerConnectionFactory?.dispose()
        } catch (e: Exception) {
            Log.w(TAG, "Error disposing PeerConnectionFactory (may indicate use-after-free was prevented)", e)
        }
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

        // Start video streaming to session (waits for video channel to be available)
        serviceScope.launch {
            try {
                sessionController.startVideoStream(frameDataFlow)
                Log.i(TAG, "Video streaming started successfully")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start video streaming", e)
            }
        }
    }

    /**
     * Start screen capture using the scrcpy-style screen server.
     *
     * The screen server provides consent-free screen capture using SurfaceControl.
     * It must be started via adb shell with elevated privileges:
     *   adb shell CLASSPATH=/data/local/tmp/screen-server.apk \
     *     app_process / com.androidremote.screenserver.Server
     *
     * In Device Owner mode with root access, we attempt to auto-start it.
     */
    private fun startScreenServerCapture() {
        serviceScope.launch {
            // IMPORTANT: Set up the VideoStreamBridge subscription FIRST, before
            // connecting to the screen server. This ensures no early keyframes are
            // lost due to SharedFlow's replay=0 dropping emissions with no subscribers.
            try {
                Log.i(TAG, "Setting up video stream bridge (waiting for data channel)...")
                sessionController.startVideoStream(frameDataFlow)
                Log.i(TAG, "Video stream bridge ready, now connecting to screen server")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to set up video stream bridge", e)
                isScreenCaptureActive = false
                return@launch
            }

            // Initialize screen server manager if needed
            if (screenServerManager == null) {
                screenServerManager = ScreenServerManager(this@RemoteSessionService)
            }
            val manager = screenServerManager!!

            // Try to auto-start screen server if not running
            // NOTE: The screen server requires shell UID (2000) for SurfaceControl access.
            // Runtime.exec("sh") from an app gets the app's UID, NOT shell UID.
            // Only root (su) can actually start it with correct privileges.
            // For non-rooted devices, the screen server must be pre-started via ADB.
            if (!manager.isScreenServerRunning()) {
                if (manager.isRooted()) {
                    Log.i(TAG, "Attempting to auto-start screen server via root...")
                    val started = manager.startScreenServer()
                    if (started) {
                        Log.i(TAG, "Screen server auto-started successfully via root")
                        kotlinx.coroutines.delay(500)
                    } else {
                        Log.w(TAG, "Failed to auto-start screen server via root")
                    }
                } else {
                    Log.w(TAG, "Screen server not running and device is not rooted. " +
                            "Start it via ADB: adb shell CLASSPATH=/data/local/tmp/screen-server.apk " +
                            "app_process / com.androidremote.screenserver.Server")
                }
            }

            // Retry connecting to screen server — it may take a moment to start
            val maxRetries = 5
            val retryDelayMs = 1000L
            var connected = false

            for (attempt in 1..maxRetries) {
                val client = ScreenServerClient()
                screenServerClient = client

                if (client.connect()) {
                    Log.i(TAG, "Connected to screen server: ${client.videoWidth}x${client.videoHeight}")

                    // Handle early death: server crashes during capture setup
                    client.onEarlyDeath = {
                        Log.w(TAG, "Screen server died during capture setup")
                        client.disconnect()
                        screenServerClient = null
                        isScreenCaptureActive = false
                    }

                    // Forward frames to WebRTC — VideoStreamBridge is already subscribed
                    // to _frameDataFlow, so frames will be sent immediately
                    launch {
                        client.frames.collect { frame ->
                            _frameDataFlow.emit(frame)
                        }
                    }

                    Log.i(TAG, "Video streaming started via screen server")
                    connected = true
                    break
                } else {
                    client.disconnect()
                    screenServerClient = null
                    if (attempt < maxRetries) {
                        Log.w(TAG, "Screen server not available (attempt $attempt/$maxRetries), retrying in ${retryDelayMs}ms...")
                        kotlinx.coroutines.delay(retryDelayMs)
                    }
                }
            }

            if (!connected) {
                Log.e(TAG, "Screen server not available after $maxRetries attempts. " +
                        "Start it via ADB: adb shell CLASSPATH=/data/local/tmp/screen-server.apk " +
                        "app_process / com.androidremote.screenserver.Server")
                isScreenCaptureActive = false
            }
        }
    }

    /**
     * Stop screen capture and streaming.
     */
    fun stopScreenCapture() {
        sessionController.stopVideoStream()

        screenServerClient?.disconnect()
        screenServerClient = null

        screenCaptureManager?.stop()
        screenCaptureManager = null

        isScreenCaptureActive = false
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
