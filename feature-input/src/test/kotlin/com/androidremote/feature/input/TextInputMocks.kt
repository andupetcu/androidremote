package com.androidremote.feature.input

/**
 * Mock accessibility node for testing.
 */
data class MockAccessibilityNode(
    override val isEditable: Boolean,
    override val text: String,
    override val cursorPosition: Int
) : AccessibilityNode

/**
 * Mock accessibility service for testing.
 */
class MockAccessibilityService : AccessibilityServiceProvider {
    private var focusedNode: MockAccessibilityNode? = null
    private var lastSetText: String? = null
    private var lastKeyAction: KeyAction? = null
    private var setTextFails = false
    private var pasteFails = false
    private var pastePerformed = false

    fun setFocusedNode(node: MockAccessibilityNode?) {
        focusedNode = node
    }

    fun setSetTextFails(fails: Boolean) {
        setTextFails = fails
    }

    fun setPasteFails(fails: Boolean) {
        pasteFails = fails
    }

    fun getLastSetText(): String? = lastSetText

    fun getLastKeyAction(): KeyAction? = lastKeyAction

    fun wasPastePerformed(): Boolean = pastePerformed

    override fun getFocusedNode(): AccessibilityNode? = focusedNode

    override fun setText(text: String): Boolean {
        if (focusedNode == null || !focusedNode!!.isEditable) {
            return false
        }
        if (setTextFails) {
            return false
        }
        lastSetText = text
        return true
    }

    override fun performPaste(): Boolean {
        if (focusedNode == null || !focusedNode!!.isEditable) {
            return false
        }
        if (pasteFails) {
            return false
        }
        pastePerformed = true
        return true
    }

    override fun sendKeyAction(action: KeyAction): Boolean {
        if (focusedNode == null) {
            return false
        }
        lastKeyAction = action
        return true
    }
}

/**
 * Mock clipboard for testing.
 */
class MockClipboard : ClipboardProvider {
    private var clipboardText: String? = null

    fun setClipboardText(text: String) {
        clipboardText = text
    }

    fun getClipboardText(): String? = clipboardText

    override fun getText(): String? = clipboardText

    override fun setText(text: String) {
        clipboardText = text
    }
}
