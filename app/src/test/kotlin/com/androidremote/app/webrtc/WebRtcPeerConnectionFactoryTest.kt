package com.androidremote.app.webrtc

import com.androidremote.transport.IceServer
import com.androidremote.transport.PeerConnectionConfig
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Tests for WebRtcPeerConnectionFactory configuration and mapping logic.
 *
 * Note: Actual factory instantiation requires Android context, so these tests
 * focus on the configuration structures and data classes.
 */
class WebRtcPeerConnectionFactoryTest {

    @Test
    fun `PeerConnectionConfig with empty ice servers is valid`() {
        val config = PeerConnectionConfig(iceServers = emptyList())

        assertTrue(config.iceServers.isEmpty())
    }

    @Test
    fun `PeerConnectionConfig with single STUN server`() {
        val config = PeerConnectionConfig(
            iceServers = listOf(
                IceServer(urls = listOf("stun:stun.l.google.com:19302"))
            )
        )

        assertEquals(1, config.iceServers.size)
        assertEquals("stun:stun.l.google.com:19302", config.iceServers[0].urls[0])
    }

    @Test
    fun `PeerConnectionConfig with TURN server and credentials`() {
        val config = PeerConnectionConfig(
            iceServers = listOf(
                IceServer(
                    urls = listOf("turn:turn.example.com:3478"),
                    username = "user",
                    credential = "pass"
                )
            )
        )

        assertEquals(1, config.iceServers.size)
        assertEquals("turn:turn.example.com:3478", config.iceServers[0].urls[0])
        assertEquals("user", config.iceServers[0].username)
        assertEquals("pass", config.iceServers[0].credential)
    }

    @Test
    fun `PeerConnectionConfig with multiple ice servers`() {
        val config = PeerConnectionConfig(
            iceServers = listOf(
                IceServer(urls = listOf("stun:stun1.example.com:19302")),
                IceServer(urls = listOf("stun:stun2.example.com:19302")),
                IceServer(
                    urls = listOf("turn:turn.example.com:3478", "turns:turn.example.com:5349"),
                    username = "user",
                    credential = "secret"
                )
            )
        )

        assertEquals(3, config.iceServers.size)
    }

    @Test
    fun `IceServer with multiple URLs`() {
        val server = IceServer(
            urls = listOf(
                "turn:turn1.example.com:3478",
                "turn:turn2.example.com:3478",
                "turns:turn1.example.com:5349"
            ),
            username = "user",
            credential = "pass"
        )

        assertEquals(3, server.urls.size)
        assertTrue(server.urls.contains("turn:turn1.example.com:3478"))
        assertTrue(server.urls.contains("turns:turn1.example.com:5349"))
    }

    @Test
    fun `IceServer without credentials has null values`() {
        val server = IceServer(urls = listOf("stun:stun.example.com"))

        assertEquals(null, server.username)
        assertEquals(null, server.credential)
    }

    @Test
    fun `default PeerConnectionConfig has empty ice servers`() {
        val config = PeerConnectionConfig()

        assertTrue(config.iceServers.isEmpty())
    }

    @Test
    fun `IceServer data class equality works correctly`() {
        val server1 = IceServer(
            urls = listOf("stun:stun.example.com"),
            username = "user",
            credential = "pass"
        )
        val server2 = IceServer(
            urls = listOf("stun:stun.example.com"),
            username = "user",
            credential = "pass"
        )

        assertEquals(server1, server2)
    }

    @Test
    fun `PeerConnectionConfig data class equality works correctly`() {
        val config1 = PeerConnectionConfig(
            iceServers = listOf(IceServer(urls = listOf("stun:stun.example.com")))
        )
        val config2 = PeerConnectionConfig(
            iceServers = listOf(IceServer(urls = listOf("stun:stun.example.com")))
        )

        assertEquals(config1, config2)
    }
}
