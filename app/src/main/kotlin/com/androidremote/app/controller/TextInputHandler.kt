package com.androidremote.app.controller

import com.androidremote.feature.input.TextInputResult
import com.androidremote.feature.input.TextInputService
import com.androidremote.transport.RemoteCommand

/**
 * Handles text input commands.
 *
 * Bridges RemoteCommand.TypeText to the TextInputService, providing
 * a consistent CommandResult response for the command processing pipeline.
 */
class TextInputHandler(
    private val textInputService: TextInputService
) {

    /**
     * Handle a TypeText command by delegating to the text input service.
     *
     * @param cmd The TypeText command containing the text to type
     * @return CommandResult indicating success or failure
     */
    fun handleTypeText(cmd: RemoteCommand.TypeText): CommandResult {
        return when (val result = textInputService.typeText(cmd.text)) {
            is TextInputResult.Success -> CommandResult.success()
            is TextInputResult.Error -> CommandResult.error(result.message)
        }
    }
}
