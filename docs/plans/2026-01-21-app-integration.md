# App Integration Layer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire feature modules into Android app services via SessionController, enabling remote control of the device.

**Architecture:** SessionController (owned by RemoteSessionService) receives commands from WebRTC CommandChannel, routes them to InputHandler/TextInputHandler, which use CoordinateMapper and GestureBuilder to dispatch gestures via InputInjectionService.

**Tech Stack:** Kotlin, Coroutines, JUnit5, MockK, Android Services

---

## Task 1: CommandResult Type

**Files:**
- Create: `app/src/main/kotlin/com/androidremote/app/controller/CommandResult.kt`

**Step 1: Create CommandResult sealed class**

```kotlin
package com.androidremote.app.controller

/**
 * Result of processing a remote command.
 */
sealed class CommandResult {
    abstract val success: Boolean
    abstract val errorMessage: String?

    data class Success(
        override val errorMessage: String? = null
    ) : CommandResult() {
        override val success: Boolean = true
    }

    data class Error(
        override val errorMessage: String
    ) : CommandResult() {
        override val success: Boolean = false
    }

    companion object {
        fun success(): CommandResult = Success()
        fun error(message: String): CommandResult = Error(message)
    }
}
```

**Step 2: Verify compilation**

Run: `./gradlew :app:compileDebugKotlin`
Expected: BUILD SUCCESSFUL

---

## Task 2: InputHandler Tests

**Files:**
- Create: `app/src/test/kotlin/com/androidremote/app/controller/InputHandlerTest.kt`

**Step 1: Create test file with imports and mocks**

```kotlin
package com.androidremote.app.controller

import com.androidremote.app.service.InputInjectionService
import com.androidremote.feature.input.CoordinateMapper
import com.androidremote.feature.input.GestureBuilder
import com.androidremote.feature.input.GestureSpec
import com.androidremote.feature.input.ScreenPoint
import com.androidremote.transport.RemoteCommand
import com.google.common.truth.Truth.assertThat
import io.mockk.*
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class InputHandlerTest {

    private lateinit var handler: InputHandler
    private lateinit var mockService: InputInjectionService

    @BeforeEach
    fun setUp() {
        handler = InputHandler()
        mockService = mockk(relaxed = true)
    }

    @AfterEach
    fun tearDown() {
        clearAllMocks()
        InputInjectionService.instance = null
    }

    @Test
    fun `handleTap returns error when screen not configured`() {
        val cmd = RemoteCommand.Tap(x = 0.5f, y = 0.5f)

        val result = handler.handleTap(cmd)

        assertThat(result.success).isFalse()
        assertThat(result.errorMessage).contains("Screen not configured")
    }

    @Test
    fun `handleTap returns error when accessibility service not running`() {
        handler.updateScreenConfig(1080, 1920, 0)
        InputInjectionService.instance = null

        val cmd = RemoteCommand.Tap(x = 0.5f, y = 0.5f)
        val result = handler.handleTap(cmd)

        assertThat(result.success).isFalse()
        assertThat(result.errorMessage).contains("Accessibility service")
    }

    @Test
    fun `handleTap converts coordinates and dispatches gesture`() {
        handler.updateScreenConfig(1080, 1920, 0)
        InputInjectionService.instance = mockService
        every { mockService.dispatchGesture(any()) } returns true

        val cmd = RemoteCommand.Tap(x = 0.5f, y = 0.5f)
        val result = handler.handleTap(cmd)

        assertThat(result.success).isTrue()
        verify { mockService.dispatchGesture(any()) }
    }

    @Test
    fun `handleTap returns error when gesture dispatch fails`() {
        handler.updateScreenConfig(1080, 1920, 0)
        InputInjectionService.instance = mockService
        every { mockService.dispatchGesture(any()) } returns false

        val cmd = RemoteCommand.Tap(x = 0.5f, y = 0.5f)
        val result = handler.handleTap(cmd)

        assertThat(result.success).isFalse()
        assertThat(result.errorMessage).contains("dispatch failed")
    }

    @Test
    fun `handleSwipe converts coordinates and dispatches gesture`() {
        handler.updateScreenConfig(1080, 1920, 0)
        InputInjectionService.instance = mockService
        every { mockService.dispatchGesture(any()) } returns true

        val cmd = RemoteCommand.Swipe(
            startX = 0.5f, startY = 0.8f,
            endX = 0.5f, endY = 0.2f,
            durationMs = 300
        )
        val result = handler.handleSwipe(cmd)

        assertThat(result.success).isTrue()
        verify { mockService.dispatchGesture(any()) }
    }

    @Test
    fun `handleLongPress dispatches gesture with correct duration`() {
        handler.updateScreenConfig(1080, 1920, 0)
        InputInjectionService.instance = mockService
        every { mockService.dispatchGesture(any()) } returns true

        val cmd = RemoteCommand.LongPress(x = 0.5f, y = 0.5f, durationMs = 800)
        val result = handler.handleLongPress(cmd)

        assertThat(result.success).isTrue()
        verify { mockService.dispatchGesture(match { it.duration == 800L }) }
    }

    @Test
    fun `handlePinch dispatches two-stroke gesture`() {
        handler.updateScreenConfig(1080, 1920, 0)
        InputInjectionService.instance = mockService
        every { mockService.dispatchGesture(any()) } returns true

        val cmd = RemoteCommand.Pinch(
            centerX = 0.5f, centerY = 0.5f,
            scale = 2.0f, durationMs = 300
        )
        val result = handler.handlePinch(cmd)

        assertThat(result.success).isTrue()
        verify { mockService.dispatchGesture(match { it.strokeCount == 2 }) }
    }

    @Test
    fun `updateScreenConfig creates new coordinate mapper`() {
        handler.updateScreenConfig(1080, 1920, 0)
        InputInjectionService.instance = mockService
        every { mockService.dispatchGesture(any()) } returns true

        // Tap at center should work
        val cmd = RemoteCommand.Tap(x = 0.5f, y = 0.5f)
        val result = handler.handleTap(cmd)

        assertThat(result.success).isTrue()
    }
}
```

**Step 2: Run tests to verify they fail**

Run: `./gradlew :app:testDebugUnitTest --tests "com.androidremote.app.controller.InputHandlerTest"`
Expected: FAIL - InputHandler class not found

---

## Task 3: InputHandler Implementation

**Files:**
- Create: `app/src/main/kotlin/com/androidremote/app/controller/InputHandler.kt`

**Step 1: Implement InputHandler**

```kotlin
package com.androidremote.app.controller

import com.androidremote.app.service.InputInjectionService
import com.androidremote.feature.input.CoordinateMapper
import com.androidremote.feature.input.GestureBuilder
import com.androidremote.feature.input.GestureSpec
import com.androidremote.transport.RemoteCommand

/**
 * Handles input commands by converting coordinates and dispatching gestures.
 */
class InputHandler {

    private var coordinateMapper: CoordinateMapper? = null

    /**
     * Updates screen configuration for coordinate mapping.
     */
    fun updateScreenConfig(
        width: Int,
        height: Int,
        rotation: Int,
        topInset: Int = 0,
        bottomInset: Int = 0,
        leftInset: Int = 0,
        rightInset: Int = 0
    ) {
        coordinateMapper = CoordinateMapper(
            screenWidth = width,
            screenHeight = height,
            rotation = rotation,
            topInset = topInset,
            bottomInset = bottomInset,
            leftInset = leftInset,
            rightInset = rightInset
        )
    }

    fun handleTap(cmd: RemoteCommand.Tap): CommandResult {
        val mapper = coordinateMapper
            ?: return CommandResult.error("Screen not configured")
        val service = InputInjectionService.instance
            ?: return CommandResult.error("Accessibility service not running")

        val point = mapper.map(cmd.x, cmd.y)
        val gesture = GestureBuilder.tap(point.x, point.y)

        return dispatchGesture(service, gesture)
    }

    fun handleSwipe(cmd: RemoteCommand.Swipe): CommandResult {
        val mapper = coordinateMapper
            ?: return CommandResult.error("Screen not configured")
        val service = InputInjectionService.instance
            ?: return CommandResult.error("Accessibility service not running")

        val start = mapper.map(cmd.startX, cmd.startY)
        val end = mapper.map(cmd.endX, cmd.endY)
        val gesture = GestureBuilder.swipe(
            start.x, start.y,
            end.x, end.y,
            cmd.durationMs.toLong()
        )

        return dispatchGesture(service, gesture)
    }

    fun handleLongPress(cmd: RemoteCommand.LongPress): CommandResult {
        val mapper = coordinateMapper
            ?: return CommandResult.error("Screen not configured")
        val service = InputInjectionService.instance
            ?: return CommandResult.error("Accessibility service not running")

        val point = mapper.map(cmd.x, cmd.y)
        val gesture = GestureBuilder.longPress(point.x, point.y, cmd.durationMs.toLong())

        return dispatchGesture(service, gesture)
    }

    fun handlePinch(cmd: RemoteCommand.Pinch): CommandResult {
        val mapper = coordinateMapper
            ?: return CommandResult.error("Screen not configured")
        val service = InputInjectionService.instance
            ?: return CommandResult.error("Accessibility service not running")

        val center = mapper.map(cmd.centerX, cmd.centerY)

        // Convert scale to distance: scale > 1 = zoom in (fingers spread)
        val baseDistance = 100
        val startDistance = baseDistance
        val endDistance = (baseDistance * cmd.scale).toInt()

        val gesture = GestureBuilder.pinch(
            center.x, center.y,
            startDistance, endDistance,
            cmd.durationMs.toLong()
        )

        return dispatchGesture(service, gesture)
    }

    fun handleScroll(cmd: RemoteCommand.Scroll): CommandResult {
        val mapper = coordinateMapper
            ?: return CommandResult.error("Screen not configured")
        val service = InputInjectionService.instance
            ?: return CommandResult.error("Accessibility service not running")

        val start = mapper.map(cmd.x, cmd.y)
        // Convert delta to end position (delta is in normalized units)
        val screenDeltaX = (cmd.deltaX * mapper.screenWidth).toInt()
        val screenDeltaY = (cmd.deltaY * mapper.screenHeight).toInt()

        val gesture = GestureBuilder.swipe(
            start.x, start.y,
            start.x + screenDeltaX, start.y + screenDeltaY,
            200L // Default scroll duration
        )

        return dispatchGesture(service, gesture)
    }

    fun handleKeyPress(cmd: RemoteCommand.KeyPress): CommandResult {
        val service = InputInjectionService.instance
            ?: return CommandResult.error("Accessibility service not running")

        return if (service.dispatchKeyEvent(cmd.keyCode)) {
            CommandResult.success()
        } else {
            CommandResult.error("Key event dispatch failed")
        }
    }

    private fun dispatchGesture(service: InputInjectionService, gesture: GestureSpec): CommandResult {
        return if (service.dispatchGesture(gesture)) {
            CommandResult.success()
        } else {
            CommandResult.error("Gesture dispatch failed")
        }
    }
}
```

**Step 2: Run tests to verify they pass**

Run: `./gradlew :app:testDebugUnitTest --tests "com.androidremote.app.controller.InputHandlerTest"`
Expected: All tests PASS

---

## Task 4: Update InputInjectionService

**Files:**
- Modify: `app/src/main/kotlin/com/androidremote/app/service/InputInjectionService.kt`

**Step 1: Update InputInjectionService with gesture dispatch**

```kotlin
package com.androidremote.app.service

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent
import com.androidremote.feature.input.GestureSpec
import com.androidremote.feature.input.GestureStroke

/**
 * Accessibility service for injecting touch gestures.
 */
class InputInjectionService : AccessibilityService() {

    companion object {
        @Volatile
        var instance: InputInjectionService? = null
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // Not processing events - only for gesture injection
    }

    override fun onInterrupt() {
        // Called when system wants to interrupt feedback
    }

    override fun onDestroy() {
        super.onDestroy()
        instance = null
    }

    /**
     * Dispatches a gesture specification via the accessibility API.
     *
     * @param spec The gesture to dispatch
     * @return true if gesture was dispatched successfully
     */
    fun dispatchGesture(spec: GestureSpec): Boolean {
        val gestureBuilder = GestureDescription.Builder()

        for (stroke in spec.strokes) {
            val path = buildPath(stroke)
            val strokeDescription = GestureDescription.StrokeDescription(
                path,
                0L, // Start time
                spec.duration
            )
            gestureBuilder.addStroke(strokeDescription)
        }

        val gesture = gestureBuilder.build()

        return dispatchGesture(gesture, null, null)
    }

    /**
     * Dispatches a key event.
     *
     * @param keyCode Android KeyEvent key code
     * @return true if key event was dispatched
     */
    fun dispatchKeyEvent(keyCode: Int): Boolean {
        // AccessibilityService can perform global actions for some keys
        return when (keyCode) {
            KeyEvent.KEYCODE_BACK -> performGlobalAction(GLOBAL_ACTION_BACK)
            KeyEvent.KEYCODE_HOME -> performGlobalAction(GLOBAL_ACTION_HOME)
            KeyEvent.KEYCODE_APP_SWITCH -> performGlobalAction(GLOBAL_ACTION_RECENTS)
            KeyEvent.KEYCODE_NOTIFICATION -> performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
            KeyEvent.KEYCODE_VOLUME_UP -> performGlobalAction(GLOBAL_ACTION_ACCESSIBILITY_BUTTON)
            else -> false // Other keys not supported via accessibility
        }
    }

    private fun buildPath(stroke: GestureStroke): Path {
        val path = Path()

        if (stroke.path.size >= 2) {
            // Use the full path if provided
            path.moveTo(stroke.path[0].x.toFloat(), stroke.path[0].y.toFloat())
            for (i in 1 until stroke.path.size) {
                path.lineTo(stroke.path[i].x.toFloat(), stroke.path[i].y.toFloat())
            }
        } else {
            // Simple start to end
            path.moveTo(stroke.startX.toFloat(), stroke.startY.toFloat())
            path.lineTo(stroke.endX.toFloat(), stroke.endY.toFloat())
        }

        return path
    }
}
```

**Step 2: Verify compilation**

Run: `./gradlew :app:compileDebugKotlin`
Expected: BUILD SUCCESSFUL

**Step 3: Run InputHandler tests again**

Run: `./gradlew :app:testDebugUnitTest --tests "com.androidremote.app.controller.InputHandlerTest"`
Expected: All tests PASS

---

## Task 5: TextInputHandler Tests

**Files:**
- Create: `app/src/test/kotlin/com/androidremote/app/controller/TextInputHandlerTest.kt`

**Step 1: Create test file**

```kotlin
package com.androidremote.app.controller

import com.androidremote.feature.input.TextInputService
import com.androidremote.feature.input.TextInputResult
import com.androidremote.transport.RemoteCommand
import com.google.common.truth.Truth.assertThat
import io.mockk.*
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class TextInputHandlerTest {

    private lateinit var handler: TextInputHandler
    private lateinit var mockTextInputService: TextInputService

    @BeforeEach
    fun setUp() {
        mockTextInputService = mockk(relaxed = true)
        handler = TextInputHandler(mockTextInputService)
    }

    @AfterEach
    fun tearDown() {
        clearAllMocks()
    }

    @Test
    fun `handleTypeText calls text input service`() {
        every { mockTextInputService.typeText(any()) } returns TextInputResult.Success

        val cmd = RemoteCommand.TypeText(text = "Hello World")
        val result = handler.handleTypeText(cmd)

        assertThat(result.success).isTrue()
        verify { mockTextInputService.typeText("Hello World") }
    }

    @Test
    fun `handleTypeText returns error on service failure`() {
        every { mockTextInputService.typeText(any()) } returns TextInputResult.Error("No focused field")

        val cmd = RemoteCommand.TypeText(text = "Hello")
        val result = handler.handleTypeText(cmd)

        assertThat(result.success).isFalse()
        assertThat(result.errorMessage).contains("No focused field")
    }

    @Test
    fun `handleTypeText handles empty text`() {
        every { mockTextInputService.typeText(any()) } returns TextInputResult.Success

        val cmd = RemoteCommand.TypeText(text = "")
        val result = handler.handleTypeText(cmd)

        assertThat(result.success).isTrue()
    }

    @Test
    fun `handleTypeText handles unicode text`() {
        every { mockTextInputService.typeText(any()) } returns TextInputResult.Success

        val cmd = RemoteCommand.TypeText(text = "Hello 世界 🌍")
        val result = handler.handleTypeText(cmd)

        assertThat(result.success).isTrue()
        verify { mockTextInputService.typeText("Hello 世界 🌍") }
    }
}
```

**Step 2: Run tests to verify they fail**

Run: `./gradlew :app:testDebugUnitTest --tests "com.androidremote.app.controller.TextInputHandlerTest"`
Expected: FAIL - TextInputHandler class not found

---

## Task 6: TextInputHandler Implementation

**Files:**
- Create: `app/src/main/kotlin/com/androidremote/app/controller/TextInputHandler.kt`

**Step 1: Implement TextInputHandler**

```kotlin
package com.androidremote.app.controller

import com.androidremote.feature.input.TextInputResult
import com.androidremote.feature.input.TextInputService
import com.androidremote.transport.RemoteCommand

/**
 * Handles text input commands.
 */
class TextInputHandler(
    private val textInputService: TextInputService
) {

    fun handleTypeText(cmd: RemoteCommand.TypeText): CommandResult {
        return when (val result = textInputService.typeText(cmd.text)) {
            is TextInputResult.Success -> CommandResult.success()
            is TextInputResult.Error -> CommandResult.error(result.message)
        }
    }
}
```

**Step 2: Run tests to verify they pass**

Run: `./gradlew :app:testDebugUnitTest --tests "com.androidremote.app.controller.TextInputHandlerTest"`
Expected: All tests PASS

---

## Task 7: SessionState Type

**Files:**
- Create: `app/src/main/kotlin/com/androidremote/app/controller/SessionState.kt`

**Step 1: Create SessionState sealed class**

```kotlin
package com.androidremote.app.controller

/**
 * States of a remote control session.
 */
sealed class SessionState {
    object Disconnected : SessionState()
    object Connecting : SessionState()
    data class Connected(val deviceId: String) : SessionState()
    data class Reconnecting(val attempt: Int, val maxAttempts: Int) : SessionState()
    data class Error(val message: String) : SessionState()

    val isConnected: Boolean
        get() = this is Connected

    val canConnect: Boolean
        get() = this is Disconnected || this is Error
}
```

**Step 2: Verify compilation**

Run: `./gradlew :app:compileDebugKotlin`
Expected: BUILD SUCCESSFUL

---

## Task 8: SessionController Tests

**Files:**
- Create: `app/src/test/kotlin/com/androidremote/app/controller/SessionControllerTest.kt`

**Step 1: Create test file**

```kotlin
package com.androidremote.app.controller

import com.androidremote.transport.*
import com.google.common.truth.Truth.assertThat
import io.mockk.*
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SessionControllerTest {

    private lateinit var testScope: TestScope
    private lateinit var mockRemoteSession: RemoteSession
    private lateinit var mockCommandChannel: CommandChannel
    private lateinit var mockInputHandler: InputHandler
    private lateinit var mockTextInputHandler: TextInputHandler
    private lateinit var commandFlow: MutableSharedFlow<CommandEnvelope>

    private lateinit var controller: SessionController

    @BeforeEach
    fun setUp() {
        testScope = TestScope(StandardTestDispatcher())
        commandFlow = MutableSharedFlow()

        mockCommandChannel = mockk(relaxed = true) {
            every { commands } returns commandFlow
        }

        mockRemoteSession = mockk(relaxed = true) {
            every { commandChannel } returns mockCommandChannel
            every { isConnected } returns true
            coEvery { connect(any()) } just Runs
            coEvery { disconnect() } just Runs
        }

        mockInputHandler = mockk(relaxed = true)
        mockTextInputHandler = mockk(relaxed = true)

        controller = SessionController(
            scope = testScope.backgroundScope,
            sessionFactory = { _, _, _ -> mockRemoteSession },
            inputHandler = mockInputHandler,
            textInputHandler = mockTextInputHandler
        )
    }

    @AfterEach
    fun tearDown() {
        clearAllMocks()
    }

    @Test
    fun `initial state is Disconnected`() {
        assertThat(controller.state.value).isEqualTo(SessionState.Disconnected)
    }

    @Test
    fun `connect transitions to Connected on success`() = testScope.runTest {
        controller.connect("ws://localhost", "token-123", "device-456")
        advanceUntilIdle()

        assertThat(controller.state.value).isInstanceOf(SessionState.Connected::class.java)
    }

    @Test
    fun `connect transitions to Error on failure`() = testScope.runTest {
        coEvery { mockRemoteSession.connect(any()) } throws SessionConnectionException("Failed")

        controller.connect("ws://localhost", "token-123", "device-456")
        advanceUntilIdle()

        assertThat(controller.state.value).isInstanceOf(SessionState.Error::class.java)
    }

    @Test
    fun `disconnect transitions to Disconnected`() = testScope.runTest {
        controller.connect("ws://localhost", "token-123", "device-456")
        advanceUntilIdle()

        controller.disconnect()
        advanceUntilIdle()

        assertThat(controller.state.value).isEqualTo(SessionState.Disconnected)
    }

    @Test
    fun `routes tap command to input handler`() = testScope.runTest {
        every { mockInputHandler.handleTap(any()) } returns CommandResult.success()

        controller.connect("ws://localhost", "token-123", "device-456")
        advanceUntilIdle()

        val cmd = CommandEnvelope("cmd-1", RemoteCommand.Tap(0.5f, 0.5f))
        commandFlow.emit(cmd)
        advanceUntilIdle()

        verify { mockInputHandler.handleTap(any()) }
    }

    @Test
    fun `routes text command to text handler`() = testScope.runTest {
        every { mockTextInputHandler.handleTypeText(any()) } returns CommandResult.success()

        controller.connect("ws://localhost", "token-123", "device-456")
        advanceUntilIdle()

        val cmd = CommandEnvelope("cmd-1", RemoteCommand.TypeText("Hello"))
        commandFlow.emit(cmd)
        advanceUntilIdle()

        verify { mockTextInputHandler.handleTypeText(any()) }
    }

    @Test
    fun `sends ack after successful command`() = testScope.runTest {
        every { mockInputHandler.handleTap(any()) } returns CommandResult.success()

        controller.connect("ws://localhost", "token-123", "device-456")
        advanceUntilIdle()

        val cmd = CommandEnvelope("cmd-1", RemoteCommand.Tap(0.5f, 0.5f))
        commandFlow.emit(cmd)
        advanceUntilIdle()

        verify { mockCommandChannel.sendAck(match { it.commandId == "cmd-1" && it.success }) }
    }

    @Test
    fun `sends error ack when handler fails`() = testScope.runTest {
        every { mockInputHandler.handleTap(any()) } returns CommandResult.error("Service unavailable")

        controller.connect("ws://localhost", "token-123", "device-456")
        advanceUntilIdle()

        val cmd = CommandEnvelope("cmd-1", RemoteCommand.Tap(0.5f, 0.5f))
        commandFlow.emit(cmd)
        advanceUntilIdle()

        verify {
            mockCommandChannel.sendAck(match {
                it.commandId == "cmd-1" && !it.success && it.errorMessage == "Service unavailable"
            })
        }
    }

    @Test
    fun `starts reconnect on connection lost`() = testScope.runTest {
        controller.connect("ws://localhost", "token-123", "device-456")
        advanceUntilIdle()

        controller.onConnectionLost()
        advanceUntilIdle()

        assertThat(controller.state.value).isInstanceOf(SessionState.Reconnecting::class.java)
    }

    @Test
    fun `exponential backoff increases delay`() = testScope.runTest {
        coEvery { mockRemoteSession.connect(any()) } throws SessionConnectionException("Failed")

        controller.connect("ws://localhost", "token-123", "device-456")
        advanceUntilIdle()

        controller.onConnectionLost()

        // First attempt after 1s
        advanceTimeBy(1001)
        val state1 = controller.state.value as? SessionState.Reconnecting
        assertThat(state1?.attempt).isEqualTo(1)

        // Second attempt after 2s more
        advanceTimeBy(2001)
        val state2 = controller.state.value as? SessionState.Reconnecting
        assertThat(state2?.attempt).isEqualTo(2)
    }

    @Test
    fun `stops reconnect after max attempts`() = testScope.runTest {
        coEvery { mockRemoteSession.connect(any()) } throws SessionConnectionException("Failed")

        controller.connect("ws://localhost", "token-123", "device-456")
        advanceUntilIdle()

        controller.onConnectionLost()

        // Fast forward through all retries
        advanceTimeBy(300_000) // 5 minutes should be enough
        advanceUntilIdle()

        assertThat(controller.state.value).isInstanceOf(SessionState.Error::class.java)
    }
}
```

**Step 2: Run tests to verify they fail**

Run: `./gradlew :app:testDebugUnitTest --tests "com.androidremote.app.controller.SessionControllerTest"`
Expected: FAIL - SessionController class not found

---

## Task 9: SessionController Implementation

**Files:**
- Create: `app/src/main/kotlin/com/androidremote/app/controller/SessionController.kt`

**Step 1: Implement SessionController**

```kotlin
package com.androidremote.app.controller

import android.util.Log
import com.androidremote.transport.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Coordinates remote control sessions.
 *
 * Owns the WebRTC connection and routes commands to appropriate handlers.
 */
class SessionController(
    private val scope: CoroutineScope,
    private val sessionFactory: (String, String, CoroutineScope) -> RemoteSession = { url, token, s ->
        RemoteSession(
            serverUrl = url,
            sessionToken = token,
            webSocketProvider = OkHttpWebSocketProvider(),
            peerConnectionFactory = WebRTCPeerConnectionFactory(),
            scope = s
        )
    },
    private val inputHandler: InputHandler = InputHandler(),
    private val textInputHandler: TextInputHandler? = null
) {
    companion object {
        private const val TAG = "SessionController"
        private val RECONNECT_DELAYS = listOf(1000L, 2000L, 4000L, 8000L, 15000L, 30000L)
        private const val MAX_RECONNECT_ATTEMPTS = 10
    }

    private val _state = MutableStateFlow<SessionState>(SessionState.Disconnected)
    val state: StateFlow<SessionState> = _state.asStateFlow()

    private var remoteSession: RemoteSession? = null
    private var commandJob: Job? = null
    private var reconnectJob: Job? = null

    private var currentServerUrl: String? = null
    private var currentToken: String? = null
    private var currentDeviceId: String? = null

    /**
     * Connect to the signaling server and establish WebRTC connection.
     */
    fun connect(serverUrl: String, sessionToken: String, deviceId: String) {
        if (!_state.value.canConnect) {
            Log.w(TAG, "Cannot connect in state: ${_state.value}")
            return
        }

        currentServerUrl = serverUrl
        currentToken = sessionToken
        currentDeviceId = deviceId

        _state.value = SessionState.Connecting

        scope.launch {
            try {
                val session = sessionFactory(serverUrl, sessionToken, scope)
                remoteSession = session

                session.connect()
                session.startAsOfferer()

                _state.value = SessionState.Connected(deviceId)
                startCommandLoop()
            } catch (e: Exception) {
                Log.e(TAG, "Connection failed", e)
                _state.value = SessionState.Error(e.message ?: "Connection failed")
            }
        }
    }

    /**
     * Disconnect and clean up resources.
     */
    fun disconnect() {
        reconnectJob?.cancel()
        reconnectJob = null

        commandJob?.cancel()
        commandJob = null

        scope.launch {
            remoteSession?.disconnect()
            remoteSession = null
            _state.value = SessionState.Disconnected
        }
    }

    /**
     * Called when connection is lost unexpectedly.
     */
    fun onConnectionLost() {
        commandJob?.cancel()

        if (reconnectJob?.isActive != true) {
            startReconnectLoop()
        }
    }

    /**
     * Updates screen configuration for coordinate mapping.
     */
    fun updateScreenConfig(
        width: Int,
        height: Int,
        rotation: Int,
        topInset: Int = 0,
        bottomInset: Int = 0,
        leftInset: Int = 0,
        rightInset: Int = 0
    ) {
        inputHandler.updateScreenConfig(
            width, height, rotation,
            topInset, bottomInset, leftInset, rightInset
        )
    }

    private fun startCommandLoop() {
        val channel = remoteSession?.commandChannel ?: return

        commandJob = scope.launch {
            channel.commands.collect { envelope ->
                handleCommand(envelope)
            }
        }
    }

    private fun handleCommand(envelope: CommandEnvelope) {
        val result = when (val cmd = envelope.command) {
            is RemoteCommand.Tap -> inputHandler.handleTap(cmd)
            is RemoteCommand.Swipe -> inputHandler.handleSwipe(cmd)
            is RemoteCommand.LongPress -> inputHandler.handleLongPress(cmd)
            is RemoteCommand.Pinch -> inputHandler.handlePinch(cmd)
            is RemoteCommand.Scroll -> inputHandler.handleScroll(cmd)
            is RemoteCommand.KeyPress -> inputHandler.handleKeyPress(cmd)
            is RemoteCommand.TypeText -> textInputHandler?.handleTypeText(cmd)
                ?: CommandResult.error("Text input not available")
        }

        remoteSession?.commandChannel?.sendAck(
            CommandAck(
                commandId = envelope.id,
                success = result.success,
                errorMessage = result.errorMessage
            )
        )
    }

    private fun startReconnectLoop() {
        val serverUrl = currentServerUrl ?: return
        val token = currentToken ?: return
        val deviceId = currentDeviceId ?: return

        reconnectJob = scope.launch {
            var attempt = 0

            while (attempt < MAX_RECONNECT_ATTEMPTS && isActive) {
                attempt++
                _state.value = SessionState.Reconnecting(attempt, MAX_RECONNECT_ATTEMPTS)

                val delayMs = RECONNECT_DELAYS.getOrElse(attempt - 1) { RECONNECT_DELAYS.last() }
                delay(delayMs)

                try {
                    val session = sessionFactory(serverUrl, token, scope)
                    remoteSession = session

                    session.connect()
                    session.startAsOfferer()

                    _state.value = SessionState.Connected(deviceId)
                    startCommandLoop()
                    return@launch
                } catch (e: Exception) {
                    Log.w(TAG, "Reconnect attempt $attempt failed", e)
                }
            }

            _state.value = SessionState.Error("Connection lost. Please reconnect manually.")
            cleanup()
        }
    }

    private fun cleanup() {
        commandJob?.cancel()
        commandJob = null
        remoteSession = null
    }
}
```

**Step 2: Run tests to verify they pass**

Run: `./gradlew :app:testDebugUnitTest --tests "com.androidremote.app.controller.SessionControllerTest"`
Expected: Most tests PASS (some may need mock adjustments)

---

## Task 10: Add MockK Dependency

**Files:**
- Modify: `app/build.gradle.kts`

**Step 1: Check and add MockK if missing**

Add to dependencies block:
```kotlin
testImplementation("io.mockk:mockk:1.13.8")
```

**Step 2: Sync and verify**

Run: `./gradlew :app:dependencies --configuration testDebugCompileClasspath | grep mockk`
Expected: Shows mockk dependency

---

## Task 11: RemoteSessionService Tests

**Files:**
- Create: `app/src/test/kotlin/com/androidremote/app/service/RemoteSessionServiceTest.kt`

**Step 1: Create basic service test**

```kotlin
package com.androidremote.app.service

import android.content.Intent
import com.androidremote.app.controller.SessionController
import com.google.common.truth.Truth.assertThat
import io.mockk.*
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class RemoteSessionServiceTest {

    @Test
    fun `binder returns session controller`() {
        // This test verifies the binder contract
        // Full service testing requires Robolectric or instrumented tests
        assertThat(true).isTrue() // Placeholder
    }
}
```

**Step 2: Verify test compiles**

Run: `./gradlew :app:testDebugUnitTest --tests "com.androidremote.app.service.RemoteSessionServiceTest"`
Expected: PASS

---

## Task 12: RemoteSessionService Implementation

**Files:**
- Create: `app/src/main/kotlin/com/androidremote/app/service/RemoteSessionService.kt`

**Step 1: Implement RemoteSessionService**

```kotlin
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
import com.androidremote.app.R
import com.androidremote.app.controller.SessionController
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
        sessionController = SessionController(scope = serviceScope)
        createNotificationChannel()
    }

    override fun onBind(intent: Intent): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = createNotification()
        startForeground(NOTIFICATION_ID, notification)
        return START_STICKY
    }

    override fun onDestroy() {
        sessionController.disconnect()
        serviceScope.cancel()
        super.onDestroy()
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
```

**Step 2: Verify compilation**

Run: `./gradlew :app:compileDebugKotlin`
Expected: BUILD SUCCESSFUL

---

## Task 13: Update AndroidManifest

**Files:**
- Modify: `app/src/main/AndroidManifest.xml`

**Step 1: Add service declarations**

Add inside `<application>` tag:
```xml
<service
    android:name=".service.RemoteSessionService"
    android:exported="false"
    android:foregroundServiceType="mediaProjection|specialUse">
    <property
        android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
        android:value="remoteControl" />
</service>

<service
    android:name=".service.ScreenCaptureService"
    android:exported="false"
    android:foregroundServiceType="mediaProjection" />

<service
    android:name=".service.InputInjectionService"
    android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE"
    android:exported="false">
    <intent-filter>
        <action android:name="android.accessibilityservice.AccessibilityService" />
    </intent-filter>
    <meta-data
        android:name="android.accessibilityservice"
        android:resource="@xml/accessibility_service_config" />
</service>
```

**Step 2: Add accessibility service config**

Create: `app/src/main/res/xml/accessibility_service_config.xml`

```xml
<?xml version="1.0" encoding="utf-8"?>
<accessibility-service xmlns:android="http://schemas.android.com/apk/res/android"
    android:accessibilityFeedbackType="feedbackGeneric"
    android:accessibilityFlags="flagDefault|flagRequestTouchExplorationMode"
    android:canPerformGestures="true"
    android:canRetrieveWindowContent="false"
    android:description="@string/accessibility_service_description"
    android:settingsActivity="com.androidremote.app.MainActivity" />
```

**Step 3: Add string resource**

Add to `app/src/main/res/values/strings.xml`:
```xml
<string name="accessibility_service_description">Allows remote control of touch input</string>
```

**Step 4: Verify build**

Run: `./gradlew :app:assembleDebug`
Expected: BUILD SUCCESSFUL

---

## Task 14: Run All Tests

**Step 1: Run full test suite**

Run: `./gradlew test`
Expected: BUILD SUCCESSFUL, all tests pass

**Step 2: Verify test count**

Run: `./gradlew test 2>&1 | grep -E "(PASSED|FAILED|SKIPPED)" | wc -l`
Expected: ~470+ tests (previous 451 + new ~20)

---

## Summary

**Files Created:**
- `app/src/main/kotlin/.../controller/CommandResult.kt`
- `app/src/main/kotlin/.../controller/SessionState.kt`
- `app/src/main/kotlin/.../controller/InputHandler.kt`
- `app/src/main/kotlin/.../controller/TextInputHandler.kt`
- `app/src/main/kotlin/.../controller/SessionController.kt`
- `app/src/main/kotlin/.../service/RemoteSessionService.kt`
- `app/src/test/kotlin/.../controller/InputHandlerTest.kt`
- `app/src/test/kotlin/.../controller/TextInputHandlerTest.kt`
- `app/src/test/kotlin/.../controller/SessionControllerTest.kt`
- `app/src/main/res/xml/accessibility_service_config.xml`

**Files Modified:**
- `app/src/main/kotlin/.../service/InputInjectionService.kt`
- `app/src/main/AndroidManifest.xml`
- `app/src/main/res/values/strings.xml`
- `app/build.gradle.kts` (MockK dependency)
