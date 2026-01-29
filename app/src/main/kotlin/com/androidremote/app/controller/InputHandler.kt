package com.androidremote.app.controller

import android.util.Log
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

        // Shell injection: execute all taps in a single shell command for precise timing
        shellInjector?.let { injector ->
            return runBlocking {
                // Build a single shell command that does all taps with sleep between them
                val sleepSec = cmd.intervalMs / 1000.0
                val tapCommands = (1..cmd.count).joinToString(" && ") { i ->
                    if (i < cmd.count) {
                        "input tap ${point.x} ${point.y} && sleep $sleepSec"
                    } else {
                        "input tap ${point.x} ${point.y}"
                    }
                }

                // Run as a single shell invocation for minimal overhead
                val cmdArray = if (injector.getName() == "ADB Shell") {
                    // Use the shell injector's root detection
                    arrayOf("su", "0", "sh", "-c", tapCommands)
                } else {
                    arrayOf("sh", "-c", tapCommands)
                }

                try {
                    val process = Runtime.getRuntime().exec(cmdArray)
                    val exitCode = process.waitFor()
                    if (exitCode == 0) {
                        CommandResult.success()
                    } else {
                        CommandResult.error("Multi-tap shell command failed with exit code $exitCode")
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Shell multi-tap failed: ${e.message}, trying sequential")
                    // Fallback: do taps sequentially through the injector
                    for (i in 1..cmd.count) {
                        val result = injector.tap(point.x, point.y)
                        if (result.isFailure) return@runBlocking CommandResult.error("Tap $i failed: ${result.exceptionOrNull()?.message}")
                        if (i < cmd.count) {
                            kotlinx.coroutines.delay(cmd.intervalMs.toLong())
                        }
                    }
                    CommandResult.success()
                }
            }
        }

        // Fallback: sequential accessibility taps
        for (i in 1..cmd.count) {
            val result = dispatchGestureViaAccessibility(GestureBuilder.tap(point.x, point.y))
            if (!result.success) return result
            if (i < cmd.count) {
                Thread.sleep(cmd.intervalMs.toLong())
            }
        }
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
