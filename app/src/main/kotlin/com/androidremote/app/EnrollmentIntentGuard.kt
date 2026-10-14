package com.androidremote.app

import java.net.URI

/**
 * Decides what to do with `enrollment_token` / `server_url` extras on the launch intent.
 * MainActivity is exported, so any app can send them (AM-14).
 */
object EnrollmentIntentGuard {

    sealed class Decision {
        /** Already enrolled: extras are never honoured. */
        object IgnoreEnrolled : Decision()

        /** Missing token or malformed server URL. */
        object IgnoreInvalid : Decision()

        /** Launched by adb shell / root / this app: honour directly. */
        object Accept : Decision()

        /** Launched by anything else (or unknown): the user must confirm on screen. */
        object RequireConfirmation : Decision()
    }

    private const val UID_ROOT = 0
    private const val UID_SHELL = 2000

    fun decide(
        enrolled: Boolean,
        callerUid: Int?,
        ownUid: Int,
        token: String?,
        serverUrl: String?
    ): Decision {
        if (enrolled) return Decision.IgnoreEnrolled
        if (token.isNullOrBlank()) return Decision.IgnoreInvalid
        if (serverUrl != null && !isValidServerUrl(serverUrl)) return Decision.IgnoreInvalid

        val trusted = callerUid != null && callerUid >= 0 &&
            (callerUid == UID_ROOT || callerUid == UID_SHELL || callerUid == ownUid)
        return if (trusted) Decision.Accept else Decision.RequireConfirmation
    }

    fun isValidServerUrl(url: String): Boolean = try {
        val uri = URI(url.trim())
        (uri.scheme == "http" || uri.scheme == "https") && !uri.host.isNullOrBlank()
    } catch (e: Exception) {
        false
    }
}
