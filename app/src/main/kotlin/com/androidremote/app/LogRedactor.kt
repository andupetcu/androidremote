package com.androidremote.app

import java.net.URI

/** Helpers that keep secrets, typed text and token-bearing URLs out of logs (AR-18, AM-23). */
object LogRedactor {

    fun secret(value: String?): String = if (value == null) "<none>" else "<redacted:${value.length} chars>"

    fun typedText(text: String?): String = if (text == null) "<none>" else "<text:${text.length} chars>"

    /** scheme://host[:port] only; never userinfo, path, query or fragment. */
    fun url(url: String?): String {
        if (url == null) return "<none>"
        return try {
            val u = URI(url.trim())
            val host = u.host
            if (u.scheme == null || host == null) {
                "<unparseable url>"
            } else {
                buildString {
                    append(u.scheme).append("://").append(host)
                    if (u.port != -1) append(':').append(u.port)
                }
            }
        } catch (e: Exception) {
            "<unparseable url>"
        }
    }

    private val sensitiveParam = Regex("""(?i)\b((?:session_?)?token|enrollment_?token|password|secret|key)=[^&\s]+""")
    private val bearer = Regex("""(?i)\b(bearer)\s+\S+""")

    /** Scrub token-like substrings out of free text. */
    fun scrub(text: String): String =
        text.replace(sensitiveParam) { "${it.groupValues[1]}=<redacted>" }
            .replace(bearer) { "${it.groupValues[1]} <redacted>" }
}
