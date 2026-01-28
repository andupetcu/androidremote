package com.androidremote.feature.input

import com.google.common.truth.Truth.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.assertThrows

/**
 * Tests for text input functionality.
 *
 * Text input is performed via AccessibilityService, with a fallback
 * to clipboard paste when direct setText fails. This enables typing
 * text into focused input fields on the remote device.
 *
 * These tests are written FIRST (TDD) - implementation follows.
 */
class TextInputTest {

    private lateinit var mockAccessibilityService: MockAccessibilityService
    private lateinit var mockClipboard: MockClipboard
    private lateinit var textInput: TextInputService

    @BeforeEach
    fun setUp() {
        mockAccessibilityService = MockAccessibilityService()
        mockClipboard = MockClipboard()
        textInput = TextInputService(mockAccessibilityService, mockClipboard)
    }

    // ==================== Direct Text Input ====================

    @Test
    fun `sets text via accessibility`() {
        mockAccessibilityService.setFocusedNode(createEditableNode())

        val result = textInput.setText("Hello, World!")

        assertThat(result).isTrue()
        assertThat(mockAccessibilityService.getLastSetText()).isEqualTo("Hello, World!")
    }

    @Test
    fun `sets empty text`() {
        mockAccessibilityService.setFocusedNode(createEditableNode())

        val result = textInput.setText("")

        assertThat(result).isTrue()
        assertThat(mockAccessibilityService.getLastSetText()).isEqualTo("")
    }

    @Test
    fun `sets unicode text`() {
        mockAccessibilityService.setFocusedNode(createEditableNode())

        val result = textInput.setText("Hello 世界 🌍")

        assertThat(result).isTrue()
        assertThat(mockAccessibilityService.getLastSetText()).isEqualTo("Hello 世界 🌍")
    }

    @Test
    fun `sets text with special characters`() {
        mockAccessibilityService.setFocusedNode(createEditableNode())

        val result = textInput.setText("Hello\nWorld\t!")

        assertThat(result).isTrue()
        assertThat(mockAccessibilityService.getLastSetText()).isEqualTo("Hello\nWorld\t!")
    }

    @Test
    fun `returns false when no focused node`() {
        mockAccessibilityService.setFocusedNode(null)

        val result = textInput.setText("Hello")

        assertThat(result).isFalse()
    }

    @Test
    fun `returns false when focused node is not editable`() {
        mockAccessibilityService.setFocusedNode(createNonEditableNode())

        val result = textInput.setText("Hello")

        assertThat(result).isFalse()
    }

    // ==================== Clipboard Fallback ====================

    @Test
    fun `falls back to clipboard paste when setText fails`() {
        mockAccessibilityService.setFocusedNode(createEditableNode())
        mockAccessibilityService.setSetTextFails(true)

        val result = textInput.setText("Hello via clipboard")

        assertThat(result).isTrue()
        assertThat(mockClipboard.getClipboardText()).isEqualTo("Hello via clipboard")
        assertThat(mockAccessibilityService.wasPastePerformed()).isTrue()
    }

    @Test
    fun `clipboard fallback fails when paste fails`() {
        mockAccessibilityService.setFocusedNode(createEditableNode())
        mockAccessibilityService.setSetTextFails(true)
        mockAccessibilityService.setPasteFails(true)

        val result = textInput.setText("Hello")

        assertThat(result).isFalse()
    }

    @Test
    fun `restores clipboard after paste fallback`() {
        mockAccessibilityService.setFocusedNode(createEditableNode())
        mockAccessibilityService.setSetTextFails(true)
        mockClipboard.setClipboardText("Original clipboard content")

        textInput.setText("New text")

        assertThat(mockClipboard.getClipboardText()).isEqualTo("Original clipboard content")
    }

    // ==================== Append Text ====================

    @Test
    fun `appends text to existing content`() {
        mockAccessibilityService.setFocusedNode(createEditableNode(existingText = "Hello"))

        val result = textInput.appendText(" World")

        assertThat(result).isTrue()
        assertThat(mockAccessibilityService.getLastSetText()).isEqualTo("Hello World")
    }

    @Test
    fun `append to empty field sets text`() {
        mockAccessibilityService.setFocusedNode(createEditableNode(existingText = ""))

        val result = textInput.appendText("Hello")

        assertThat(result).isTrue()
        assertThat(mockAccessibilityService.getLastSetText()).isEqualTo("Hello")
    }

    @Test
    fun `append returns false when no focused node`() {
        mockAccessibilityService.setFocusedNode(null)

        val result = textInput.appendText("Hello")

        assertThat(result).isFalse()
    }

    // ==================== Clear Text ====================

    @Test
    fun `clears text from focused field`() {
        mockAccessibilityService.setFocusedNode(createEditableNode(existingText = "Some text"))

        val result = textInput.clearText()

        assertThat(result).isTrue()
        assertThat(mockAccessibilityService.getLastSetText()).isEqualTo("")
    }

    @Test
    fun `clear returns false when no focused node`() {
        mockAccessibilityService.setFocusedNode(null)

        val result = textInput.clearText()

        assertThat(result).isFalse()
    }

    // ==================== Insert At Cursor ====================

    @Test
    fun `inserts text at cursor position`() {
        mockAccessibilityService.setFocusedNode(
            createEditableNode(existingText = "HelloWorld", cursorPosition = 5)
        )

        val result = textInput.insertAtCursor(" ")

        assertThat(result).isTrue()
        assertThat(mockAccessibilityService.getLastSetText()).isEqualTo("Hello World")
    }

    @Test
    fun `inserts at beginning when cursor at 0`() {
        mockAccessibilityService.setFocusedNode(
            createEditableNode(existingText = "World", cursorPosition = 0)
        )

        val result = textInput.insertAtCursor("Hello ")

        assertThat(result).isTrue()
        assertThat(mockAccessibilityService.getLastSetText()).isEqualTo("Hello World")
    }

    @Test
    fun `inserts at end when cursor at end`() {
        mockAccessibilityService.setFocusedNode(
            createEditableNode(existingText = "Hello", cursorPosition = 5)
        )

        val result = textInput.insertAtCursor(" World")

        assertThat(result).isTrue()
        assertThat(mockAccessibilityService.getLastSetText()).isEqualTo("Hello World")
    }

    // ==================== Key Events ====================

    @Test
    fun `sends enter key`() {
        mockAccessibilityService.setFocusedNode(createEditableNode())

        val result = textInput.sendEnter()

        assertThat(result).isTrue()
        assertThat(mockAccessibilityService.getLastKeyAction()).isEqualTo(KeyAction.ENTER)
    }

    @Test
    fun `sends backspace key`() {
        mockAccessibilityService.setFocusedNode(createEditableNode())

        val result = textInput.sendBackspace()

        assertThat(result).isTrue()
        assertThat(mockAccessibilityService.getLastKeyAction()).isEqualTo(KeyAction.BACKSPACE)
    }

    @Test
    fun `sends delete key`() {
        mockAccessibilityService.setFocusedNode(createEditableNode())

        val result = textInput.sendDelete()

        assertThat(result).isTrue()
        assertThat(mockAccessibilityService.getLastKeyAction()).isEqualTo(KeyAction.DELETE)
    }

    @Test
    fun `sends tab key`() {
        mockAccessibilityService.setFocusedNode(createEditableNode())

        val result = textInput.sendTab()

        assertThat(result).isTrue()
        assertThat(mockAccessibilityService.getLastKeyAction()).isEqualTo(KeyAction.TAB)
    }

    // ==================== Focus Management ====================

    @Test
    fun `checks if editable field is focused`() {
        mockAccessibilityService.setFocusedNode(createEditableNode())

        val hasFocus = textInput.hasEditableFocus()

        assertThat(hasFocus).isTrue()
    }

    @Test
    fun `returns false when non-editable focused`() {
        mockAccessibilityService.setFocusedNode(createNonEditableNode())

        val hasFocus = textInput.hasEditableFocus()

        assertThat(hasFocus).isFalse()
    }

    @Test
    fun `returns false when nothing focused`() {
        mockAccessibilityService.setFocusedNode(null)

        val hasFocus = textInput.hasEditableFocus()

        assertThat(hasFocus).isFalse()
    }

    @Test
    fun `gets current text from focused field`() {
        mockAccessibilityService.setFocusedNode(createEditableNode(existingText = "Current text"))

        val text = textInput.getCurrentText()

        assertThat(text).isEqualTo("Current text")
    }

    @Test
    fun `returns null text when nothing focused`() {
        mockAccessibilityService.setFocusedNode(null)

        val text = textInput.getCurrentText()

        assertThat(text).isNull()
    }

    // ==================== Helper Functions ====================

    private fun createEditableNode(
        existingText: String = "",
        cursorPosition: Int = existingText.length
    ): MockAccessibilityNode {
        return MockAccessibilityNode(
            isEditable = true,
            text = existingText,
            cursorPosition = cursorPosition
        )
    }

    private fun createNonEditableNode(): MockAccessibilityNode {
        return MockAccessibilityNode(
            isEditable = false,
            text = "Read-only text",
            cursorPosition = 0
        )
    }
}
