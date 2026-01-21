package com.androidremote.app.controller

import com.androidremote.feature.input.TextInputResult
import com.androidremote.feature.input.TextInputService
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
