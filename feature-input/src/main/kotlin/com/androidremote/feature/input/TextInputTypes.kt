package com.androidremote.feature.input

/**
 * Result of a text input operation.
 */
sealed class TextInputResult {
    object Success : TextInputResult()
    data class Error(val message: String) : TextInputResult()
}

/**
 * Key actions that can be sent via accessibility.
 */
enum class KeyAction {
    ENTER,
    BACKSPACE,
    DELETE,
    TAB,
    ESCAPE
}

/**
 * Represents an accessibility node for text input.
 */
interface AccessibilityNode {
    val isEditable: Boolean
    val text: String
    val cursorPosition: Int
}

/**
 * Abstraction over Android's AccessibilityService for testability.
 */
interface AccessibilityServiceProvider {
    /**
     * Get the currently focused node.
     */
    fun getFocusedNode(): AccessibilityNode?

    /**
     * Set text on the focused node.
     *
     * @return true if successful
     */
    fun setText(text: String): Boolean

    /**
     * Perform paste action on focused node.
     *
     * @return true if successful
     */
    fun performPaste(): Boolean

    /**
     * Send a key action.
     *
     * @return true if successful
     */
    fun sendKeyAction(action: KeyAction): Boolean
}

/**
 * Abstraction over Android's ClipboardManager for testability.
 */
interface ClipboardProvider {
    /**
     * Get current clipboard text.
     */
    fun getText(): String?

    /**
     * Set clipboard text.
     */
    fun setText(text: String)
}
