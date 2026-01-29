package com.androidremote.app.controller

import android.util.Log
import com.androidremote.feature.input.InputInjector
import com.androidremote.feature.input.TextInputResult
import com.androidremote.feature.input.TextInputService
import com.androidremote.transport.RemoteCommand
import kotlinx.coroutines.runBlocking

/**
 * Handles text input commands.
 *
 * Uses shell injection (input text) as primary method on rooted devices,
 * falling back to AccessibilityService setText/clipboard paste.
 */
class TextInputHandler(
    private val textInputService: TextInputService,
    private val shellInjector: InputInjector? = null
) {

    companion object {
        private const val TAG = "TextInputHandler"
    }

    fun handleTypeText(cmd: RemoteCommand.TypeText): CommandResult {
        // Try shell injection first (most reliable on rooted devices)
        shellInjector?.let { injector ->
            val result = runBlocking { injector.text(cmd.text) }
            if (result.isSuccess) return CommandResult.success()
            Log.w(TAG, "Shell text failed: ${result.exceptionOrNull()?.message}, trying accessibility")
        }

        // Fallback to accessibility service
        return when (val result = textInputService.typeText(cmd.text)) {
            is TextInputResult.Success -> CommandResult.success()
            is TextInputResult.Error -> CommandResult.error(result.message)
        }
    }
}
