package com.androidremote.transport

import kotlinx.coroutines.flow.Flow

/**
 * Interface for WebSocket connections.
 * Allows for dependency injection and easier testing.
 */
interface WebSocketProvider {
    /**
     * Connect to a WebSocket server.
     *
     * @param url The WebSocket URL to connect to
     * @param headers Additional headers to include in the connection
     * @return A WebSocketSession for sending/receiving messages
     * @throws SignalingConnectionException if connection fails
     */
    suspend fun connect(url: String, headers: Map<String, String>): WebSocketSession
}

/**
 * Represents an active WebSocket session.
 */
interface WebSocketSession {
    /**
     * Whether the session is currently connected.
     */
    val isConnected: Boolean

    /**
     * Flow of incoming messages.
     */
    val incoming: Flow<String>

    /**
     * Send a text message.
     */
    suspend fun send(message: String)

    /**
     * Close the connection.
     */
    suspend fun close()
}
