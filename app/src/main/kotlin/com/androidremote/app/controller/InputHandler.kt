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
        val screenDeltaX = (cmd.deltaX * mapper.screenWidth).toInt()
        val screenDeltaY = (cmd.deltaY * mapper.screenHeight).toInt()

        val gesture = GestureBuilder.swipe(
            start.x, start.y,
            start.x + screenDeltaX, start.y + screenDeltaY,
            200L
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
