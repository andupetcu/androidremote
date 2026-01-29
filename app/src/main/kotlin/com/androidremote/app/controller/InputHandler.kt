package com.androidremote.app.controller

import android.hardware.input.InputManager
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.MotionEvent
import com.androidremote.app.service.InputInjectionService
import com.androidremote.feature.input.CoordinateMapper
import com.androidremote.feature.input.GestureBuilder
import com.androidremote.feature.input.GestureSpec
import com.androidremote.feature.input.InputInjector
import com.androidremote.feature.input.InputInjectorFactory
import com.androidremote.transport.RemoteCommand
import kotlinx.coroutines.runBlocking

/**
 * Handles input commands by converting coordinates and dispatching gestures.
 *
 * Uses a two-tier injection strategy:
 * 1. Shell input injection (via AdbShellInjector) — most reliable, works on rooted devices
 * 2. AccessibilityService dispatchGesture — fallback for non-rooted devices
 */
class InputHandler {

    companion object {
        private const val TAG = "InputHandler"
    }

    private var coordinateMapper: CoordinateMapper? = null
    private var shellInjector: InputInjector? = null

    init {
        // Try to initialize shell-based input injection (works on rooted devices)
        val injector = InputInjectorFactory.create()
        if (injector != null && injector.isAvailable()) {
            shellInjector = injector
            Log.i(TAG, "Using shell input injector: ${injector.getName()}")
        } else {
            Log.i(TAG, "Shell input not available, using AccessibilityService gestures")
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
            ?: return CommandResult.error("Screen not configured").also {
                Log.w(TAG, "TAP failed: coordinateMapper is null")
            }

        val point = mapper.map(cmd.x, cmd.y)
        Log.d(TAG, "TAP: normalized=(${cmd.x}, ${cmd.y}) -> screen=(${point.x}, ${point.y}), mapper=${mapper.screenWidth}x${mapper.screenHeight}")

        // Try shell injection first (most reliable on rooted devices)
        shellInjector?.let { injector ->
            return runBlocking {
                injector.tap(point.x, point.y).fold(
                    onSuccess = { CommandResult.success() },
                    onFailure = { e ->
                        Log.w(TAG, "Shell tap failed: ${e.message}, trying accessibility")
                        dispatchGestureViaAccessibility(GestureBuilder.tap(point.x, point.y))
                    }
                )
            }
        }

        // Fallback to AccessibilityService
        return dispatchGestureViaAccessibility(GestureBuilder.tap(point.x, point.y))
    }

    fun handleSwipe(cmd: RemoteCommand.Swipe): CommandResult {
        val mapper = coordinateMapper
            ?: return CommandResult.error("Screen not configured")

        val start = mapper.map(cmd.startX, cmd.startY)
        val end = mapper.map(cmd.endX, cmd.endY)
        val durationMs = cmd.durationMs.toLong()

        shellInjector?.let { injector ->
            return runBlocking {
                injector.swipe(start.x, start.y, end.x, end.y, durationMs).fold(
                    onSuccess = { CommandResult.success() },
                    onFailure = { e ->
                        Log.w(TAG, "Shell swipe failed: ${e.message}, trying accessibility")
                        dispatchGestureViaAccessibility(
                            GestureBuilder.swipe(start.x, start.y, end.x, end.y, durationMs)
                        )
                    }
                )
            }
        }

        return dispatchGestureViaAccessibility(
            GestureBuilder.swipe(start.x, start.y, end.x, end.y, durationMs)
        )
    }

    fun handleLongPress(cmd: RemoteCommand.LongPress): CommandResult {
        val mapper = coordinateMapper
            ?: return CommandResult.error("Screen not configured")

        val point = mapper.map(cmd.x, cmd.y)
        val durationMs = cmd.durationMs.toLong()

        shellInjector?.let { injector ->
            return runBlocking {
                injector.longPress(point.x, point.y, durationMs).fold(
                    onSuccess = { CommandResult.success() },
                    onFailure = { e ->
                        Log.w(TAG, "Shell longPress failed: ${e.message}, trying accessibility")
                        dispatchGestureViaAccessibility(
                            GestureBuilder.longPress(point.x, point.y, durationMs)
                        )
                    }
                )
            }
        }

        return dispatchGestureViaAccessibility(
            GestureBuilder.longPress(point.x, point.y, durationMs)
        )
    }

    fun handlePinch(cmd: RemoteCommand.Pinch): CommandResult {
        val mapper = coordinateMapper
            ?: return CommandResult.error("Screen not configured")
        val service = InputInjectionService.instance
            ?: return CommandResult.error("Accessibility service not running")

        val center = mapper.map(cmd.centerX, cmd.centerY)
        val baseDistance = 100
        val startDistance = baseDistance
        val endDistance = (baseDistance * cmd.scale).toInt()

        val gesture = GestureBuilder.pinch(
            center.x, center.y,
            startDistance, endDistance,
            cmd.durationMs.toLong()
        )

        return dispatchGestureViaAccessibility(gesture)
    }

    fun handleScroll(cmd: RemoteCommand.Scroll): CommandResult {
        val mapper = coordinateMapper
            ?: return CommandResult.error("Screen not configured")

        val start = mapper.map(cmd.x, cmd.y)
        val screenDeltaX = (cmd.deltaX * mapper.screenWidth).toInt()
        val screenDeltaY = (cmd.deltaY * mapper.screenHeight).toInt()

        val gesture = GestureBuilder.swipe(
            start.x, start.y,
            start.x + screenDeltaX, start.y + screenDeltaY,
            200L
        )

        return dispatchGestureViaAccessibility(gesture)
    }

    fun handleMultiTap(cmd: RemoteCommand.MultiTap): CommandResult {
        val mapper = coordinateMapper
            ?: return CommandResult.error("Screen not configured")

        val point = mapper.map(cmd.x, cmd.y)
        Log.d(TAG, "MULTI_TAP: count=${cmd.count}, interval=${cmd.intervalMs}ms at screen=(${point.x}, ${point.y})")

        // Use InputManager.injectInputEvent() via reflection for rapid in-process injection.
        // Shell `input tap` spawns a new Dalvik VM per call (~1.1s each), far too slow for multi-tap.
        return try {
            injectMultiTapViaInputManager(point.x.toFloat(), point.y.toFloat(), cmd.count, cmd.intervalMs.toLong())
        } catch (e: Exception) {
            Log.w(TAG, "InputManager inject failed: ${e.message}, falling back to shell")
            // Fallback: sequential shell taps (slow but functional)
            shellInjector?.let { injector ->
                runBlocking {
                    for (i in 1..cmd.count) {
                        injector.tap(point.x, point.y)
                        if (i < cmd.count) kotlinx.coroutines.delay(cmd.intervalMs.toLong())
                    }
                }
            }
            CommandResult.success()
        }
    }

    /**
     * Inject rapid multi-tap using InputManager.injectInputEvent() via reflection.
     * This is in-process and takes <1ms per event, enabling precise timing.
     */
    private fun injectMultiTapViaInputManager(
        x: Float, y: Float, count: Int, intervalMs: Long
    ): CommandResult {
        val inputManager = InputManager::class.java.getDeclaredMethod("getInstance")
            .invoke(null) as InputManager

        val injectMethod = InputManager::class.java.getDeclaredMethod(
            "injectInputEvent",
            android.view.InputEvent::class.java,
            Int::class.javaPrimitiveType
        )

        // INJECT_INPUT_EVENT_MODE_ASYNC = 0
        val INJECT_MODE_ASYNC = 0

        val props = MotionEvent.PointerProperties().apply {
            id = 0
            toolType = MotionEvent.TOOL_TYPE_FINGER
        }
        val propsArray = arrayOf(props)

        for (i in 1..count) {
            val downTime = SystemClock.uptimeMillis()

            val coordsDown = MotionEvent.PointerCoords().apply {
                this.x = x; this.y = y
                pressure = 1.0f; size = 1.0f
            }

            val down = MotionEvent.obtain(
                downTime, downTime,
                MotionEvent.ACTION_DOWN, 1,
                propsArray, arrayOf(coordsDown),
                0, 0, 1.0f, 1.0f,
                0, 0,
                InputDevice.SOURCE_TOUCHSCREEN, 0
            )

            val upTime = downTime + 10 // short tap
            val up = MotionEvent.obtain(
                downTime, upTime,
                MotionEvent.ACTION_UP, 1,
                propsArray, arrayOf(coordsDown),
                0, 0, 1.0f, 1.0f,
                0, 0,
                InputDevice.SOURCE_TOUCHSCREEN, 0
            )

            val downOk = injectMethod.invoke(inputManager, down, INJECT_MODE_ASYNC) as Boolean
            val upOk = injectMethod.invoke(inputManager, up, INJECT_MODE_ASYNC) as Boolean

            down.recycle()
            up.recycle()

            Log.d(TAG, "MULTI_TAP[$i/$count]: down=$downOk, up=$upOk")

            if (!downOk || !upOk) {
                return CommandResult.error("Tap $i injection failed (down=$downOk, up=$upOk)")
            }

            if (i < count) {
                Thread.sleep(intervalMs)
            }
        }

        Log.d(TAG, "MULTI_TAP: all $count taps injected successfully")
        return CommandResult.success()
    }

    fun handleKeyPress(cmd: RemoteCommand.KeyPress): CommandResult {
        // Try shell injection first
        shellInjector?.let { injector ->
            val result = runBlocking { injector.keyEvent(cmd.keyCode) }
            if (result.isSuccess) return CommandResult.success()
            Log.w(TAG, "Shell keyEvent failed: ${result.exceptionOrNull()?.message}, trying accessibility")
        }

        // Fallback to AccessibilityService
        val service = InputInjectionService.instance
            ?: return CommandResult.error("Accessibility service not running")

        return if (service.dispatchKeyEvent(cmd.keyCode)) {
            CommandResult.success()
        } else {
            CommandResult.error("Key event dispatch failed")
        }
    }

    private fun dispatchGestureViaAccessibility(gesture: GestureSpec): CommandResult {
        val service = InputInjectionService.instance
            ?: return CommandResult.error("Accessibility service not running")

        return if (service.dispatchGesture(gesture)) {
            CommandResult.success()
        } else {
            Log.w(TAG, "Gesture dispatch failed: strokes=${gesture.strokeCount}, duration=${gesture.duration}ms")
            CommandResult.error("Gesture dispatch failed")
        }
    }
}
