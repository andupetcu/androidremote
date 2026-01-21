package com.androidremote.app.controller

/**
 * Result of processing a remote command.
 */
sealed class CommandResult {
    abstract val success: Boolean
    abstract val errorMessage: String?

    data class Success(
        override val errorMessage: String? = null
    ) : CommandResult() {
        override val success: Boolean = true
    }

    data class Error(
        override val errorMessage: String
    ) : CommandResult() {
        override val success: Boolean = false
    }

    companion object {
        fun success(): CommandResult = Success()
        fun error(message: String): CommandResult = Error(message)
    }
}
