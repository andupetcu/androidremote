package com.androidremote.app.controller

/**
 * States of a remote control session.
 */
sealed class SessionState {
    object Disconnected : SessionState()
    object Connecting : SessionState()
    data class Connected(val deviceId: String) : SessionState()
    data class Reconnecting(val attempt: Int, val maxAttempts: Int) : SessionState()
    data class Error(val message: String) : SessionState()

    val isConnected: Boolean
        get() = this is Connected

    val canConnect: Boolean
        get() = this is Disconnected || this is Error
}
