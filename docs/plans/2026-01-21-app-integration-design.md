# App Integration Layer Design

> Design for wiring feature modules into Android app services

## Decisions

| Decision | Choice |
|----------|--------|
| Command routing | Session Controller (central coordination) |
| Lifecycle management | Bound Service |
| AccessibilityService communication | Static instance + callbacks |
| Screen capture pipeline | Direct Surface (hardware encoding) |
| Reconnection strategy | Auto-reconnect with exponential backoff |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      MainActivity                            │
│  - Permission wizard                                        │
│  - Pairing UI                                               │
│  - Binds to RemoteSessionService                            │
└─────────────────────┬───────────────────────────────────────┘
                      │ binds
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                  RemoteSessionService                        │
│  - Foreground service with notification                     │
│  - Owns SessionController                                   │
│  - Manages service lifecycle                                │
└─────────────────────┬───────────────────────────────────────┘
                      │ owns
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                   SessionController                          │
│  - Owns RemoteSession (WebRTC)                              │
│  - Routes commands to handlers                              │
│  - Manages reconnection logic                               │
│  - Coordinates ScreenCaptureService                         │
└────────┬─────────────────┬──────────────────┬───────────────┘
         │                 │                  │
         ▼                 ▼                  ▼
┌─────────────┐  ┌─────────────────┐  ┌──────────────────┐
│ InputHandler│  │ScreenCapture   │  │ TextInputHandler │
│ (gestures)  │  │Service         │  │                  │
└─────────────┘  └─────────────────┘  └──────────────────┘
         │
         ▼
┌─────────────────────────┐
│ InputInjectionService   │
│ (AccessibilityService)  │
│ - static instance       │
└─────────────────────────┘
```

## Components

### SessionController

Central coordinator for remote control sessions.

```kotlin
class SessionController(
    private val context: Context,
    private val scope: CoroutineScope
) {
    private val _state = MutableStateFlow<SessionState>(SessionState.Disconnected)
    val state: StateFlow<SessionState> = _state.asStateFlow()

    private var remoteSession: RemoteSession? = null
    private var commandJob: Job? = null
    private var reconnectJob: Job? = null

    private val inputHandler = InputHandler()
    private val textInputHandler = TextInputHandler()

    private var screenCaptureIntent: Intent? = null
}

sealed class SessionState {
    object Disconnected : SessionState()
    object Connecting : SessionState()
    data class Connected(val deviceId: String) : SessionState()
    data class Reconnecting(val attempt: Int, val maxAttempts: Int) : SessionState()
    data class Error(val message: String) : SessionState()
}
```

**Key methods:**
- `connect(serverUrl, sessionToken)` - Establish WebRTC connection
- `disconnect()` - Clean shutdown
- `startScreenCapture(mediaProjectionIntent)` - Begin streaming
- `stopScreenCapture()` - End streaming

### Command Routing

```kotlin
private fun handleCommand(envelope: CommandEnvelope) {
    val result = when (val cmd = envelope.command) {
        is RemoteCommand.Tap -> inputHandler.handleTap(cmd)
        is RemoteCommand.Swipe -> inputHandler.handleSwipe(cmd)
        is RemoteCommand.LongPress -> inputHandler.handleLongPress(cmd)
        is RemoteCommand.Pinch -> inputHandler.handlePinch(cmd)
        is RemoteCommand.Scroll -> inputHandler.handleScroll(cmd)
        is RemoteCommand.TypeText -> textInputHandler.handleTypeText(cmd)
        is RemoteCommand.KeyPress -> inputHandler.handleKeyPress(cmd)
    }

    remoteSession?.commandChannel?.sendAck(
        CommandAck(envelope.id, result.success, result.errorMessage)
    )
}
```

### InputHandler

Bridges remote commands to gesture injection.

```kotlin
class InputHandler {
    private var coordinateMapper: CoordinateMapper? = null

    fun updateScreenConfig(width: Int, height: Int, rotation: Int, insets: Insets) {
        coordinateMapper = CoordinateMapper(width, height, rotation,
            insets.top, insets.bottom, insets.left, insets.right)
    }

    fun handleTap(cmd: RemoteCommand.Tap): CommandResult {
        val mapper = coordinateMapper ?: return CommandResult.error("Screen not configured")
        val service = InputInjectionService.instance
            ?: return CommandResult.error("Accessibility service not running")

        val point = mapper.map(cmd.x, cmd.y)
        val gesture = GestureBuilder.tap(point.x, point.y)

        return if (service.dispatchGesture(gesture)) {
            CommandResult.success()
        } else {
            CommandResult.error("Gesture dispatch failed")
        }
    }
}
```

### ScreenCaptureService

Uses Direct Surface approach for hardware-accelerated encoding.

```kotlin
class ScreenCaptureService : Service() {
    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var mediaCodec: MediaCodec? = null

    var onEncodedFrame: ((ByteBuffer, MediaCodec.BufferInfo) -> Unit)? = null

    fun startCapture(resultCode: Int, data: Intent, config: EncoderConfig) {
        // 1. Get MediaProjection
        val projectionManager = getSystemService(MediaProjectionManager::class.java)
        mediaProjection = projectionManager.getMediaProjection(resultCode, data)

        // 2. Configure hardware encoder
        val format = MediaFormat.createVideoFormat(config.mimeType, config.width, config.height).apply {
            setInteger(MediaFormat.KEY_BIT_RATE, config.bitrate)
            setInteger(MediaFormat.KEY_FRAME_RATE, config.frameRate)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, config.iFrameIntervalSeconds)
            setInteger(MediaFormat.KEY_COLOR_FORMAT, config.colorFormat)
        }

        mediaCodec = MediaCodec.createEncoderByType(config.mimeType).apply {
            configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        }

        // 3. Create VirtualDisplay with encoder's input surface
        val surface = mediaCodec!!.createInputSurface()
        virtualDisplay = mediaProjection!!.createVirtualDisplay(
            "RemoteScreen",
            config.width, config.height, densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            surface, null, null
        )

        // 4. Start encoding
        mediaCodec!!.start()
        startEncoderOutputLoop()
    }
}
```

### Reconnection Logic

Exponential backoff with max attempts.

```kotlin
private val reconnectDelays = listOf(1000L, 2000L, 4000L, 8000L, 15000L, 30000L)
private val maxReconnectAttempts = 10

private fun startReconnectLoop() {
    reconnectJob = scope.launch {
        var attempt = 0

        while (attempt < maxReconnectAttempts && isActive) {
            attempt++
            _state.value = SessionState.Reconnecting(attempt, maxReconnectAttempts)

            val delayMs = reconnectDelays.getOrElse(attempt - 1) { reconnectDelays.last() }
            delay(delayMs)

            try {
                remoteSession?.connect()
                _state.value = SessionState.Connected(deviceId)
                restartCommandLoop()
                return@launch
            } catch (e: Exception) {
                Log.w(TAG, "Reconnect attempt $attempt failed", e)
            }
        }

        _state.value = SessionState.Error("Connection lost. Please reconnect manually.")
        cleanup()
    }
}
```

### RemoteSessionService

Bound service that owns SessionController.

```kotlin
class RemoteSessionService : Service() {
    private val binder = LocalBinder()
    private lateinit var sessionController: SessionController
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    inner class LocalBinder : Binder() {
        fun getController(): SessionController = sessionController
    }

    override fun onCreate() {
        super.onCreate()
        sessionController = SessionController(this, serviceScope)
    }

    override fun onBind(intent: Intent): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = createNotification()
        startForeground(NOTIFICATION_ID, notification)
        return START_STICKY
    }

    override fun onDestroy() {
        serviceScope.cancel()
        sessionController.disconnect()
        super.onDestroy()
    }
}
```

## Testing Strategy

### Unit Tests (JVM)

```kotlin
// SessionControllerTest.kt
class SessionControllerTest {
    @Test fun `routes tap command to input handler`()
    @Test fun `routes text command to text handler`()
    @Test fun `sends ack after successful command`()
    @Test fun `sends error ack when service unavailable`()
    @Test fun `starts reconnect loop on connection lost`()
    @Test fun `stops reconnect after max attempts`()
    @Test fun `exponential backoff increases delay`()
}

// InputHandlerTest.kt
class InputHandlerTest {
    @Test fun `converts normalized coords via mapper`()
    @Test fun `builds tap gesture and dispatches`()
    @Test fun `returns error when accessibility service null`()
    @Test fun `updates coordinate mapper on config change`()
}
```

### Mocking Approach

- Mock `RemoteSession`, `CommandChannel` for controller tests
- Mock `InputInjectionService.instance` for handler tests
- Use existing `CoordinateMapper` and `GestureBuilder` (already tested)

## Files to Create

1. `app/src/main/kotlin/.../controller/SessionController.kt`
2. `app/src/main/kotlin/.../controller/SessionState.kt`
3. `app/src/main/kotlin/.../controller/InputHandler.kt`
4. `app/src/main/kotlin/.../controller/TextInputHandler.kt`
5. `app/src/main/kotlin/.../controller/CommandResult.kt`
6. `app/src/main/kotlin/.../service/RemoteSessionService.kt`
7. `app/src/test/kotlin/.../controller/SessionControllerTest.kt`
8. `app/src/test/kotlin/.../controller/InputHandlerTest.kt`

## Files to Update

1. `app/src/main/kotlin/.../service/ScreenCaptureService.kt` - Add capture logic
2. `app/src/main/kotlin/.../service/InputInjectionService.kt` - Add gesture dispatch
3. `app/src/main/AndroidManifest.xml` - Register services
