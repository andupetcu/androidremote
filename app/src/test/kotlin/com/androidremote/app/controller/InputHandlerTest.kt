package com.androidremote.app.controller

import com.androidremote.app.service.InputInjectionService
import com.androidremote.feature.input.GestureSpec
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

        val cmd = RemoteCommand.Tap(x = 0.5f, y = 0.5f)
        val result = handler.handleTap(cmd)

        assertThat(result.success).isTrue()
    }
}
