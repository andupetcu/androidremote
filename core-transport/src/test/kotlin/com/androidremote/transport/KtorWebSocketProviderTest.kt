package com.androidremote.transport

import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

/**
 * Tests for KtorWebSocketProvider and related utilities.
 *
 * Note: Testing the actual WebSocket session behavior requires integration testing
 * with a real server, as Ktor's DefaultClientWebSocketSession is a final class
 * that cannot be mocked or extended. The session wrapper behavior is tested
 * indirectly through SignalingClientTest which uses MockWebSocketSession.
 */
class KtorWebSocketProviderTest {

    @Nested
    inner class ProviderTests {

        @Test
        fun `provider can be instantiated with default client`() {
            val provider = KtorWebSocketProvider()
            assertThat(provider).isNotNull()
        }

        @Test
        fun `connect throws SignalingConnectionException for invalid URL`() = runTest {
            val provider = KtorWebSocketProvider()

            val exception = assertThrows<SignalingConnectionException> {
                provider.connect("invalid-url", emptyMap())
            }
            assertThat(exception.message).contains("Failed to connect")
        }

        @Test
        fun `connect throws SignalingConnectionException for unreachable host`() = runTest {
            val provider = KtorWebSocketProvider()

            val exception = assertThrows<SignalingConnectionException> {
                provider.connect("ws://localhost:59999/nonexistent", emptyMap())
            }
            assertThat(exception.message).contains("Failed to connect")
        }
    }

    @Nested
    inner class UrlParsingTests {

        @Test
        fun `parseWebSocketUrl handles wss scheme`() {
            val parsed = WebSocketUrlParser.parse("wss://example.com:8443/path")

            assertThat(parsed.secure).isTrue()
            assertThat(parsed.host).isEqualTo("example.com")
            assertThat(parsed.port).isEqualTo(8443)
            assertThat(parsed.path).isEqualTo("/path")
        }

        @Test
        fun `parseWebSocketUrl handles ws scheme`() {
            val parsed = WebSocketUrlParser.parse("ws://example.com:8080/path")

            assertThat(parsed.secure).isFalse()
            assertThat(parsed.host).isEqualTo("example.com")
            assertThat(parsed.port).isEqualTo(8080)
            assertThat(parsed.path).isEqualTo("/path")
        }

        @Test
        fun `parseWebSocketUrl uses default port for wss`() {
            val parsed = WebSocketUrlParser.parse("wss://example.com/path")

            assertThat(parsed.port).isEqualTo(443)
        }

        @Test
        fun `parseWebSocketUrl uses default port for ws`() {
            val parsed = WebSocketUrlParser.parse("ws://example.com/path")

            assertThat(parsed.port).isEqualTo(80)
        }

        @Test
        fun `parseWebSocketUrl handles path with query params`() {
            val parsed = WebSocketUrlParser.parse("wss://example.com/signaling?token=abc")

            assertThat(parsed.path).isEqualTo("/signaling")
            assertThat(parsed.query).isEqualTo("token=abc")
            assertThat(parsed.fullPath).isEqualTo("/signaling?token=abc")
        }

        @Test
        fun `parseWebSocketUrl handles multiple query params`() {
            val parsed = WebSocketUrlParser.parse("wss://example.com/ws?token=abc&session=123")

            assertThat(parsed.path).isEqualTo("/ws")
            assertThat(parsed.query).isEqualTo("token=abc&session=123")
            assertThat(parsed.fullPath).isEqualTo("/ws?token=abc&session=123")
        }

        @Test
        fun `parseWebSocketUrl has null query when no query string`() {
            val parsed = WebSocketUrlParser.parse("wss://example.com/path")

            assertThat(parsed.query).isNull()
            assertThat(parsed.fullPath).isEqualTo("/path")
        }

        @Test
        fun `parseWebSocketUrl handles empty path`() {
            val parsed = WebSocketUrlParser.parse("wss://example.com")

            assertThat(parsed.path).isEqualTo("/")
        }

        @Test
        fun `parseWebSocketUrl handles root path`() {
            val parsed = WebSocketUrlParser.parse("wss://example.com/")

            assertThat(parsed.path).isEqualTo("/")
        }

        @Test
        fun `parseWebSocketUrl handles nested paths`() {
            val parsed = WebSocketUrlParser.parse("wss://example.com/api/v1/signaling")

            assertThat(parsed.path).isEqualTo("/api/v1/signaling")
        }

        @Test
        fun `parseWebSocketUrl throws on invalid scheme http`() {
            val exception = assertThrows<IllegalArgumentException> {
                WebSocketUrlParser.parse("http://example.com/path")
            }
            assertThat(exception.message).contains("Invalid WebSocket URL scheme")
        }

        @Test
        fun `parseWebSocketUrl throws on invalid scheme https`() {
            val exception = assertThrows<IllegalArgumentException> {
                WebSocketUrlParser.parse("https://example.com/path")
            }
            assertThat(exception.message).contains("Invalid WebSocket URL scheme")
        }

        @Test
        fun `parseWebSocketUrl handles uppercase scheme`() {
            val parsed = WebSocketUrlParser.parse("WSS://example.com/path")

            assertThat(parsed.secure).isTrue()
            assertThat(parsed.host).isEqualTo("example.com")
        }

        @Test
        fun `parseWebSocketUrl handles localhost`() {
            val parsed = WebSocketUrlParser.parse("ws://localhost:3000/signaling")

            assertThat(parsed.secure).isFalse()
            assertThat(parsed.host).isEqualTo("localhost")
            assertThat(parsed.port).isEqualTo(3000)
            assertThat(parsed.path).isEqualTo("/signaling")
        }

        @Test
        fun `parseWebSocketUrl handles IP address`() {
            val parsed = WebSocketUrlParser.parse("ws://192.168.1.1:8080/ws")

            assertThat(parsed.host).isEqualTo("192.168.1.1")
            assertThat(parsed.port).isEqualTo(8080)
        }

        @Test
        fun `parseWebSocketUrl handles URL with fragment`() {
            val parsed = WebSocketUrlParser.parse("ws://example.com/path#section")

            assertThat(parsed.host).isEqualTo("example.com")
            assertThat(parsed.path).isEqualTo("/path")
        }

        @Test
        fun `parseWebSocketUrl handles subdomain`() {
            val parsed = WebSocketUrlParser.parse("wss://api.example.com/v1/ws")

            assertThat(parsed.host).isEqualTo("api.example.com")
            assertThat(parsed.path).isEqualTo("/v1/ws")
        }
    }
}
