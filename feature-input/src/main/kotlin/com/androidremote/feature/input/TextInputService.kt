package com.androidremote.feature.input

/**
 * Service for text input via AccessibilityService.
 *
 * Provides text input functionality for remote control, allowing
 * typing text into focused input fields. Falls back to clipboard
 * paste when direct setText is not available.
 *
 * @property accessibilityService The accessibility service provider
 * @property clipboard The clipboard provider
 */
class TextInputService(
    private val accessibilityService: AccessibilityServiceProvider,
    private val clipboard: ClipboardProvider
) {
    /**
     * Type text into the currently focused editable field.
     *
     * This is the primary method for remote text input, returning
     * a structured result that includes error information.
     *
     * @param text The text to type
     * @return TextInputResult indicating success or failure with message
     */
    fun typeText(text: String): TextInputResult {
        val focusedNode = accessibilityService.getFocusedNode()
        if (focusedNode == null || !focusedNode.isEditable) {
            return TextInputResult.Error("No focused editable field")
        }

        // Try direct setText first
        if (accessibilityService.setText(text)) {
            return TextInputResult.Success
        }

        // Fall back to clipboard paste
        return if (pasteViaClipboard(text)) {
            TextInputResult.Success
        } else {
            TextInputResult.Error("Failed to input text")
        }
    }

    /**
     * Set text in the currently focused editable field.
     *
     * First attempts direct setText via accessibility. If that fails,
     * falls back to clipboard paste.
     *
     * @param text The text to set
     * @return true if text was set successfully
     */
    fun setText(text: String): Boolean {
        val focusedNode = accessibilityService.getFocusedNode()
        if (focusedNode == null || !focusedNode.isEditable) {
            return false
        }

        // Try direct setText first
        if (accessibilityService.setText(text)) {
            return true
        }

        // Fall back to clipboard paste
        return pasteViaClipboard(text)
    }

    /**
     * Append text to the currently focused editable field.
     *
     * @param text The text to append
     * @return true if text was appended successfully
     */
    fun appendText(text: String): Boolean {
        val focusedNode = accessibilityService.getFocusedNode()
        if (focusedNode == null || !focusedNode.isEditable) {
            return false
        }

        val newText = focusedNode.text + text
        return accessibilityService.setText(newText)
    }

    /**
     * Clear text from the currently focused editable field.
     *
     * @return true if text was cleared successfully
     */
    fun clearText(): Boolean {
        val focusedNode = accessibilityService.getFocusedNode()
        if (focusedNode == null || !focusedNode.isEditable) {
            return false
        }

        return accessibilityService.setText("")
    }

    /**
     * Insert text at the current cursor position.
     *
     * @param text The text to insert
     * @return true if text was inserted successfully
     */
    fun insertAtCursor(text: String): Boolean {
        val focusedNode = accessibilityService.getFocusedNode()
        if (focusedNode == null || !focusedNode.isEditable) {
            return false
        }

        val existingText = focusedNode.text
        val cursor = focusedNode.cursorPosition.coerceIn(0, existingText.length)

        val newText = existingText.substring(0, cursor) + text + existingText.substring(cursor)
        return accessibilityService.setText(newText)
    }

    /**
     * Send Enter key to the focused field.
     *
     * @return true if key was sent successfully
     */
    fun sendEnter(): Boolean {
        return accessibilityService.sendKeyAction(KeyAction.ENTER)
    }

    /**
     * Send Backspace key to the focused field.
     *
     * @return true if key was sent successfully
     */
    fun sendBackspace(): Boolean {
        return accessibilityService.sendKeyAction(KeyAction.BACKSPACE)
    }

    /**
     * Send Delete key to the focused field.
     *
     * @return true if key was sent successfully
     */
    fun sendDelete(): Boolean {
        return accessibilityService.sendKeyAction(KeyAction.DELETE)
    }

    /**
     * Send Tab key to move focus.
     *
     * @return true if key was sent successfully
     */
    fun sendTab(): Boolean {
        return accessibilityService.sendKeyAction(KeyAction.TAB)
    }

    /**
     * Check if an editable field is currently focused.
     */
    fun hasEditableFocus(): Boolean {
        val focusedNode = accessibilityService.getFocusedNode()
        return focusedNode != null && focusedNode.isEditable
    }

    /**
     * Get the current text from the focused field.
     *
     * @return The text, or null if no editable field is focused
     */
    fun getCurrentText(): String? {
        val focusedNode = accessibilityService.getFocusedNode()
        if (focusedNode == null || !focusedNode.isEditable) {
            return null
        }
        return focusedNode.text
    }

    /**
     * Paste text via clipboard as fallback.
     */
    private fun pasteViaClipboard(text: String): Boolean {
        // Save current clipboard content
        val originalClipboard = clipboard.getText()

        // Set our text to clipboard
        clipboard.setText(text)

        // Perform paste
        val success = accessibilityService.performPaste()

        // Restore original clipboard content
        if (originalClipboard != null) {
            clipboard.setText(originalClipboard)
        }

        return success
    }
}
