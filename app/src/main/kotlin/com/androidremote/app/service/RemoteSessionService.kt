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
import com.androidremote.app.controller.SessionListener
import com.androidremote.app.controller.SessionState
import com.androidremote.app.controller.TextInputHandler
import com.androidremote.app.webrtc.WebRtcPeerConnectionFactory
import com.androidremote.feature.input.InputInjectorFactory
import com.androidremote.feature.input.TextInputService
import com.androidremote.feature.screen.EncoderConfig
import com.androidremote.feature.screen.ScreenCaptureManager
import com.androidremote.app.api.DeviceHttpClient
import com.androidremote.app.ui.SessionStorage
import com.androidremote.transport.DeviceCommandChannel
import com.androidremote.transport.IceServerParser
import com.androidremote.transport.PeerConnectionConfig
import com.androidremote.transport.SignalingUrls
import com.androidremote.transport.FrameData
import com.androidremote.transport.KtorWebSocketProvider
import com.androidremote.transport.RemoteSession
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.Job
import kotlinx.coroutines.withContext
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

        /** Optional JSON array of ICE servers from the START_REMOTE payload (contract C7). */
        const val EXTRA_ICE_SERVERS = "ice_servers"

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

    // Screen-server capture supervisor (scrcpy-style, preferred): retries, rotation, CAPTURE_FAILED reasons
    private var captureController: ScreenCaptureController? = null
    private var frameForwardJob: Job? = null
    private var screenCaptureReceiver: BroadcastReceiver? = null

    // Decides when capture starts and stops from the session state (AR-15, AR-10)
    private val captureCoordinator = CaptureCoordinator()
    private var stateObserverJob: Job? = null

    // Input and MDM commands run here, never on Main (AR-06)
    private val inputDispatcher = InputDispatcher.create()
    private lateinit var inputHandler: InputHandler

    // ICE servers for the current session (START_REMOTE payload, else fetched from the server)
    @Volatile private var iceConfig: PeerConnectionConfig = com.androidremote.transport.RemoteSession.DEFAULT_CONFIG

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

                    startService(ScreenCaptureService.cancelIntent(this@RemoteSessionService))
                    if (resultCode == android.app.Activity.RESULT_OK && data != null) {
                        Log.i(TAG, "Screen capture permission received, starting capture")
                        // MediaProjection takes over from the screen-server supervisor.
                        captureController?.stop()
                        try {
                            startScreenCapture(resultCode, data)
                        } catch (e: Exception) {
                            Log.e(TAG, "MediaProjection capture failed to start", e)
                            sessionController.reportCaptureFailed("capture_setup_failed")
                        }
                    } else {
                        Log.w(TAG, "Screen capture permission denied or data missing")
                        sessionController.reportCaptureFailed("consent_denied")
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

        // Handle auto-start (START_REMOTE from the command poller, or boot in MDM mode)
        if (intent?.getBooleanExtra(EXTRA_AUTO_START, false) == true) {
            val serverUrl = intent.getStringExtra(EXTRA_SERVER_URL)
            val sessionToken = intent.getStringExtra(EXTRA_SESSION_TOKEN)
            val deviceId = intent.getStringExtra(EXTRA_DEVICE_ID)
            val icePayload = intent.getStringExtra(EXTRA_ICE_SERVERS)

            Log.i(TAG, "Auto-start: deviceId=$deviceId, hasToken=${sessionToken != null}, hasIce=${icePayload != null}")

            if (serverUrl != null && deviceId != null) {
                startAutoSession(serverUrl, sessionToken, deviceId, icePayload)
            } else {
                // Don't leave a "Screen is being shared" notification behind (AR-10)
                Log.w(TAG, "Auto-start missing params, stopping service")
                endServiceIfIdle()
            }
        }

        return START_STICKY
    }

    private fun startAutoSession(serverUrl: String, sessionToken: String?, deviceId: String, icePayload: String?) {
        // Clean up capture of a previous session (a re-sent START_REMOTE restarts video cleanly, AR-15)
        applyCaptureAction(captureCoordinator.beginSession(autoStarted = true))
        stateObserverJob?.cancel()

        serviceScope.launch {
            // ICE servers: payload first (C7), else ask the server with the device token
            iceConfig = if (!icePayload.isNullOrBlank()) {
                IceServerParser.parseConfigFromString(icePayload)
            } else {
                fetchIceServers()
            }
            try {
                // connect() moves the state to Connecting synchronously, so the observer
                // below can never act on the previous session's Connected value.
                sessionController.connect(serverUrl, sessionToken ?: "", deviceId)
            } catch (e: Exception) {
                Log.e(TAG, "Auto-connect failed", e)
            }
            stateObserverJob = launch {
                sessionController.state.collect { state ->
                    Log.d(TAG, "Session state changed: $state")
                    applyCaptureAction(captureCoordinator.onState(state))
                }
            }
        }
    }

    private suspend fun fetchIceServers(): PeerConnectionConfig = withContext(Dispatchers.IO) {
        val storage = SessionStorage.create(this@RemoteSessionService)
        val base = storage.getServerUrl() ?: return@withContext com.androidremote.transport.RemoteSession.DEFAULT_CONFIG
        val client = DeviceHttpClient.create(base, { storage.getSessionToken() })
        try {
            IceServersFetcher.fetch(client, base)
        } finally {
            client.close()
        }
    }

    private fun applyCaptureAction(action: CaptureAction) {
        when (action) {
            CaptureAction.NONE -> {}
            CaptureAction.START_CAPTURE -> {
                Log.i(TAG, "Session connected, starting screen capture")
                startScreenServerCapture()
            }
            CaptureAction.STOP_CAPTURE -> stopScreenCapture()
            CaptureAction.STOP_CAPTURE_AND_SERVICE -> {
                stopScreenCapture()
                endServiceIfIdle()
            }
        }
    }

    private fun endServiceIfIdle() {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
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
        inputDispatcher.close()
        super.onDestroy()
    }

    private fun createSessionController(): SessionController {
        val inputHandler = InputHandler()
        this.inputHandler = inputHandler

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
        // Reuse shell injector for text input (same root detection as InputHandler)
        val shellInjector = InputInjectorFactory.create() // availability is checked at use time (the probe runs off Main)
        val textInputHandler = TextInputHandler(textInputService, shellInjector)

        // Create MDM handler for Device Owner features
        val mdmHandler = MdmHandler(this)

        return SessionController(
            inputHandler = inputHandler,
            textInputHandler = textInputHandler,
            mdmHandler = mdmHandler,
            sessionFactory = { serverUrl, deviceId -> createRemoteSession(serverUrl, deviceId) },
            commandChannelFactory = { session -> createCommandChannel(session) },
            scope = serviceScope,
            inputDispatcher = inputDispatcher.dispatcher
        ).also { it.listener = sessionListener }
    }

    private val sessionListener = object : SessionListener {
        override fun onViewerReady() {
            // A (re)attached viewer needs a decodable frame right away (AR-04)
            requestKeyFrame()
        }

        override fun onKeyFrameRequested() = requestKeyFrame()

        override fun onSessionEnded(reason: String) {
            Log.i(TAG, "Session ended by controller: $reason")
        }
    }

    private fun requestKeyFrame() {
        captureController?.requestKeyFrame()
        screenCaptureManager?.requestKeyFrame()
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

        // The enrolment URL is http(s); signaling needs ws(s)://host/ws (AR-10)
        val signalingUrl = SignalingUrls.fromServerBase(serverUrl)
        val token = SessionStorage.create(this).getSessionToken()

        return RemoteSession(
            serverUrl = signalingUrl,
            authToken = token,
            peerConnectionConfig = iceConfig,
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
        inputHandler.updateScreenConfig(config.width, config.height, 0)
        sessionController.publishScreenInfo(config.width, config.height, 0)

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
     * Start screen capture using the scrcpy-style screen server (supervised: retries with backoff,
     * reports CAPTURE_FAILED reasons, follows rotation).
     *
     * Manual start without root: [ScreenServerManager.adbStartHint] (includes the required -u uid).
     */
    private fun startScreenServerCapture() {
        serviceScope.launch {
            // Subscribe the video bridge FIRST so no early keyframe is lost (SharedFlow replay=0).
            try {
                Log.i(TAG, "Setting up video stream bridge (waiting for data channel)...")
                sessionController.startVideoStream(frameDataFlow)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to set up video stream bridge", e)
                captureCoordinator.onCaptureStartFailed()
                return@launch
            }

            val manager = ScreenServerManager(this@RemoteSessionService)
            Log.i(TAG, "Screen server hint if it must be started by hand: ${manager.adbStartHint()}")
            val controller = ScreenCaptureController(serviceScope, ScreenServerBackend(manager))
            captureController = controller

            controller.onScreenInfo = { w, h, rotation ->
                inputHandler.updateScreenConfig(w, h, rotation)
                sessionController.publishScreenInfo(w, h, rotation)
            }
            controller.onCaptureFailed = { reason ->
                Log.w(TAG, "Capture failed: $reason")
                sessionController.reportCaptureFailed(reason)
                if (reason == CaptureFailureReason.CONSENT_REQUIRED) {
                    startService(ScreenCaptureService.promptIntent(this@RemoteSessionService))
                }
            }

            frameForwardJob?.cancel()
            frameForwardJob = launch {
                controller.frames.collect { frame -> _frameDataFlow.emit(frame) }
            }
            controller.start()
        }
    }

    /**
     * Stop screen capture and streaming.
     */
    fun stopScreenCapture() {
        sessionController.stopVideoStream()

        captureController?.stop()
        captureController = null
        frameForwardJob?.cancel()
        frameForwardJob = null

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
