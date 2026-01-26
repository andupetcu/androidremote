package com.androidremote.transport

import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocketSession
import io.ktor.http.URLProtocol
import io.ktor.websocket.CloseReason
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import io.ktor.websocket.readText
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.isActive
import java.net.URI

/**
 * Ktor-based implementation of WebSocketProvider.
 *
 * Uses Ktor's WebSocket client with OkHttp engine for reliable WebSocket
 * connections. Suitable for WebRTC signaling and other real-time communication.
 */
class KtorWebSocketProvider(
    private val httpClient: HttpClient = createDefaultClient()
) : WebSocketProvider {

    companion object {
        /**
         * Creates a default HttpClient configured for WebSocket connections.
         */
        fun createDefaultClient(): HttpClient {
            return HttpClient(OkHttp) {
                install(WebSockets) {
                    pingIntervalMillis = 20_000 // 20 seconds ping interval
                }
            }
        }
    }

    override suspend fun connect(url: String, headers: Map<String, String>): WebSocketSession {
        try {
            val parsedUrl = WebSocketUrlParser.parse(url)

            val ktorSession = httpClient.webSocketSession {
                url {
                    protocol = if (parsedUrl.secure) URLProtocol.WSS else URLProtocol.WS
                    host = parsedUrl.host
                    port = parsedUrl.port
                    pathSegments = parsedUrl.path.split("/").filter { it.isNotEmpty() }
                    parsedUrl.query?.let { queryString ->
                        queryString.split("&").forEach { param ->
                            val parts = param.split("=", limit = 2)
                            if (parts.size == 2) {
                                parameters.append(parts[0], parts[1])
                            } else {
                                parameters.append(parts[0], "")
                            }
                        }
                    }
                }
                headers.forEach { (key, value) ->
                    this.headers.append(key, value)
                }
            }

            return KtorWebSocketSession(ktorSession)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw SignalingConnectionException(
                "Failed to connect to WebSocket: $url",
                e
            )
        }
    }
}

/**
 * Ktor-based implementation of WebSocketSession.
 *
 * Wraps Ktor's DefaultClientWebSocketSession and provides a Flow-based
 * interface for incoming messages.
 */
class KtorWebSocketSession(
    private val session: DefaultClientWebSocketSession
) : WebSocketSession {

    override val isConnected: Boolean
        get() = session.isActive

    override val incoming: Flow<String> = flow {
        for (frame in session.incoming) {
            when (frame) {
                is Frame.Text -> emit(frame.readText())
                is Frame.Close -> break
                else -> { /* Ignore binary, ping, pong frames */ }
            }
        }
    }

    override suspend fun send(message: String) {
        session.send(Frame.Text(message))
    }

    override suspend fun close() {
        session.close(CloseReason(CloseReason.Codes.NORMAL, "Client closing"))
    }
}

/**
 * Parsed WebSocket URL components.
 */
data class ParsedWebSocketUrl(
    val secure: Boolean,
    val host: String,
    val port: Int,
    val path: String,
    val query: String? = null
) {
    /**
     * Full path including query string, for display/logging purposes.
     */
    val fullPath: String
        get() = if (query != null) "$path?$query" else path
}

/**
 * Utility for parsing WebSocket URLs.
 */
object WebSocketUrlParser {
    private const val WSS_SCHEME = "wss"
    private const val WS_SCHEME = "ws"
    private const val DEFAULT_WS_PORT = 80
    private const val DEFAULT_WSS_PORT = 443

    /**
     * Parse a WebSocket URL into its components.
     *
     * @param url WebSocket URL (ws:// or wss://)
     * @return Parsed URL components
     * @throws IllegalArgumentException if URL scheme is not ws or wss
     */
    fun parse(url: String): ParsedWebSocketUrl {
        val uri = URI.create(url)
        val scheme = uri.scheme?.lowercase()

        val secure = when (scheme) {
            WSS_SCHEME -> true
            WS_SCHEME -> false
            else -> throw IllegalArgumentException(
                "Invalid WebSocket URL scheme: $scheme. Expected 'ws' or 'wss'"
            )
        }

        val host = uri.host ?: throw IllegalArgumentException("Missing host in URL: $url")
        val defaultPort = if (secure) DEFAULT_WSS_PORT else DEFAULT_WS_PORT
        val port = if (uri.port > 0) uri.port else defaultPort
        val path = uri.path.ifEmpty { "/" }
        val query = uri.query?.takeIf { it.isNotEmpty() }

        return ParsedWebSocketUrl(
            secure = secure,
            host = host,
            port = port,
            path = path,
            query = query
        )
    }
}
