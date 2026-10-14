package com.androidremote.transport

import java.net.URI

/**
 * Builds the WebSocket signaling URL from the server base URL the device was enrolled with.
 */
object SignalingUrls {
    private const val WS_PATH = "/ws"

    /**
     * `http://host:port` becomes `ws://host:port/ws`, `https://host` becomes `wss://host/ws`.
     * `ws`/`wss` URLs are kept (a `/ws` path is added when the path is empty).
     *
     * @throws IllegalArgumentException for blank, malformed or non-http(s)/ws(s) URLs
     */
    fun fromServerBase(base: String): String {
        val trimmed = base.trim()
        require(trimmed.isNotEmpty()) { "Server URL is empty" }
        val uri = try {
            URI(trimmed)
        } catch (e: Exception) {
            throw IllegalArgumentException("Invalid server URL", e)
        }
        val scheme = when (uri.scheme?.lowercase()) {
            "http", "ws" -> "ws"
            "https", "wss" -> "wss"
            else -> throw IllegalArgumentException("Unsupported server URL scheme: ${uri.scheme}")
        }
        val host = uri.host ?: throw IllegalArgumentException("Missing host in server URL")
        val port = if (uri.port > 0) ":${uri.port}" else ""
        val path = uri.path.orEmpty().trimEnd('/')
        val query = uri.rawQuery?.takeIf { it.isNotEmpty() }?.let { "?$it" } ?: ""
        return "$scheme://$host$port${path.ifEmpty { WS_PATH }}$query"
    }
}
