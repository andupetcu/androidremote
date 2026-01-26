package com.androidremote.app.service

import android.accessibilityservice.AccessibilityService
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import com.androidremote.feature.input.AccessibilityNode
import com.androidremote.feature.input.AccessibilityServiceProvider
import com.androidremote.feature.input.KeyAction

/**
 * Real implementation of AccessibilityServiceProvider that delegates to InputInjectionService.
 *
 * This provider wraps the InputInjectionService to provide text input capabilities
 * via Android's accessibility framework.
 */
class InputInjectionAccessibilityProvider : AccessibilityServiceProvider {

    private val service: InputInjectionService?
        get() = InputInjectionService.instance

    override fun getFocusedNode(): AccessibilityNode? {
        val accessibilityService = service ?: return null

        return try {
            val nodeInfo = accessibilityService.rootInActiveWindow
                ?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)

            nodeInfo?.let { node ->
                InputInjectionAccessibilityNode(node)
            }
        } catch (e: Exception) {
            null
        }
    }

    override fun setText(text: String): Boolean {
        val accessibilityService = service ?: return false

        return try {
            val nodeInfo = accessibilityService.rootInActiveWindow
                ?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
                ?: return false

            if (!nodeInfo.isEditable) {
                nodeInfo.recycle()
                return false
            }

            val arguments = Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
            }

            val result = nodeInfo.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)
            nodeInfo.recycle()
            result
        } catch (e: Exception) {
            false
        }
    }

    override fun performPaste(): Boolean {
        val accessibilityService = service ?: return false

        return try {
            val nodeInfo = accessibilityService.rootInActiveWindow
                ?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
                ?: return false

            val result = nodeInfo.performAction(AccessibilityNodeInfo.ACTION_PASTE)
            nodeInfo.recycle()
            result
        } catch (e: Exception) {
            false
        }
    }

    override fun sendKeyAction(action: KeyAction): Boolean {
        val accessibilityService = service ?: return false

        return when (action) {
            KeyAction.ENTER -> dispatchKeyCode(accessibilityService, KeyEvent.KEYCODE_ENTER)
            KeyAction.BACKSPACE -> dispatchKeyCode(accessibilityService, KeyEvent.KEYCODE_DEL)
            KeyAction.DELETE -> dispatchKeyCode(accessibilityService, KeyEvent.KEYCODE_FORWARD_DEL)
            KeyAction.TAB -> dispatchKeyCode(accessibilityService, KeyEvent.KEYCODE_TAB)
            KeyAction.ESCAPE -> dispatchKeyCode(accessibilityService, KeyEvent.KEYCODE_ESCAPE)
        }
    }

    /**
     * Dispatches a key code via accessibility.
     *
     * Note: AccessibilityService has limited key dispatch capabilities.
     * For most key codes, we perform actions on the focused node instead.
     */
    private fun dispatchKeyCode(service: AccessibilityService, keyCode: Int): Boolean {
        return try {
            // For navigation keys, use global actions where available
            when (keyCode) {
                KeyEvent.KEYCODE_BACK -> service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
                KeyEvent.KEYCODE_HOME -> service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
                else -> {
                    // For text editing keys, perform action on focused node
                    val nodeInfo = service.rootInActiveWindow
                        ?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
                        ?: return false

                    val result = when (keyCode) {
                        KeyEvent.KEYCODE_DEL -> performBackspace(nodeInfo)
                        KeyEvent.KEYCODE_FORWARD_DEL -> performDelete(nodeInfo)
                        KeyEvent.KEYCODE_ENTER -> performEnter(nodeInfo)
                        KeyEvent.KEYCODE_TAB -> performTab(service)
                        KeyEvent.KEYCODE_ESCAPE -> service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
                        else -> false
                    }
                    nodeInfo.recycle()
                    result
                }
            }
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Performs backspace by modifying the text content.
     */
    private fun performBackspace(nodeInfo: AccessibilityNodeInfo): Boolean {
        if (!nodeInfo.isEditable) return false

        val currentText = nodeInfo.text?.toString() ?: ""
        if (currentText.isEmpty()) return false

        // Get cursor position if available
        val cursorPosition = nodeInfo.textSelectionEnd.takeIf { it >= 0 } ?: currentText.length

        if (cursorPosition <= 0) return false

        val newText = currentText.removeRange(cursorPosition - 1, cursorPosition)
        val arguments = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, newText)
        }

        return nodeInfo.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)
    }

    /**
     * Performs delete (forward delete) by modifying the text content.
     */
    private fun performDelete(nodeInfo: AccessibilityNodeInfo): Boolean {
        if (!nodeInfo.isEditable) return false

        val currentText = nodeInfo.text?.toString() ?: ""
        val cursorPosition = nodeInfo.textSelectionEnd.takeIf { it >= 0 } ?: currentText.length

        if (cursorPosition >= currentText.length) return false

        val newText = currentText.removeRange(cursorPosition, cursorPosition + 1)
        val arguments = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, newText)
        }

        return nodeInfo.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)
    }

    /**
     * Performs enter action on the focused node.
     */
    private fun performEnter(nodeInfo: AccessibilityNodeInfo): Boolean {
        // Try IME action first (submit form, etc.) - available on API 30+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // ACTION_IME_ENTER constant value (0x01000302) - using direct value for compatibility
            @Suppress("WrongConstant")
            if (nodeInfo.performAction(0x01000302)) {
                return true
            }
        }

        // Fall back to appending newline for multi-line fields
        if (nodeInfo.isMultiLine) {
            val currentText = nodeInfo.text?.toString() ?: ""
            val cursorPosition = nodeInfo.textSelectionEnd.takeIf { it >= 0 } ?: currentText.length
            val newText = StringBuilder(currentText).insert(cursorPosition, "\n").toString()
            val arguments = Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, newText)
            }
            return nodeInfo.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)
        }

        return false
    }

    /**
     * Performs tab action (moves focus to next element).
     */
    private fun performTab(service: AccessibilityService): Boolean {
        val nodeInfo = service.rootInActiveWindow
            ?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
            ?: return false

        val result = nodeInfo.performAction(AccessibilityNodeInfo.ACTION_NEXT_AT_MOVEMENT_GRANULARITY)
        nodeInfo.recycle()
        return result
    }
}

/**
 * Wrapper for AccessibilityNodeInfo that implements our AccessibilityNode interface.
 */
private class InputInjectionAccessibilityNode(
    private val nodeInfo: AccessibilityNodeInfo
) : AccessibilityNode {

    override val isEditable: Boolean
        get() = nodeInfo.isEditable

    override val text: String
        get() = nodeInfo.text?.toString() ?: ""

    override val cursorPosition: Int
        get() = nodeInfo.textSelectionEnd.takeIf { it >= 0 } ?: text.length
}
