package com.androidremote.app.webrtc

import com.androidremote.transport.ConnectionState
import com.androidremote.transport.IceCandidate
import com.androidremote.transport.SessionDescription
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.webrtc.IceCandidate as WebRtcIceCandidate
import org.webrtc.SessionDescription as WebRtcSessionDescription

/**
 * Tests for WebRtcPeerConnectionWrapper type conversion logic.
 *
 * Note: These tests focus on the type conversion/mapping functions since
 * the actual WebRTC operations require native libraries unavailable in unit tests.
 */
class WebRtcPeerConnectionWrapperTest {

    @Test
    fun `toWebRtcSessionDescription maps offer correctly`() {
        val description = SessionDescription(type = "offer", sdp = "v=0\r\ntest-sdp")

        val webRtcSdp = WebRtcPeerConnectionWrapper.toWebRtcSessionDescription(description)

        assertEquals(WebRtcSessionDescription.Type.OFFER, webRtcSdp.type)
        assertEquals("v=0\r\ntest-sdp", webRtcSdp.description)
    }

    @Test
    fun `toWebRtcSessionDescription maps answer correctly`() {
        val description = SessionDescription(type = "answer", sdp = "v=0\r\nanswer-sdp")

        val webRtcSdp = WebRtcPeerConnectionWrapper.toWebRtcSessionDescription(description)

        assertEquals(WebRtcSessionDescription.Type.ANSWER, webRtcSdp.type)
        assertEquals("v=0\r\nanswer-sdp", webRtcSdp.description)
    }

    @Test
    fun `toWebRtcSessionDescription maps pranswer correctly`() {
        val description = SessionDescription(type = "pranswer", sdp = "v=0\r\npranswer-sdp")

        val webRtcSdp = WebRtcPeerConnectionWrapper.toWebRtcSessionDescription(description)

        assertEquals(WebRtcSessionDescription.Type.PRANSWER, webRtcSdp.type)
    }

    @Test
    fun `toWebRtcSessionDescription is case insensitive`() {
        val upperCase = SessionDescription(type = "OFFER", sdp = "v=0\r\ntest")
        val mixedCase = SessionDescription(type = "Answer", sdp = "v=0\r\ntest")

        assertEquals(WebRtcSessionDescription.Type.OFFER, WebRtcPeerConnectionWrapper.toWebRtcSessionDescription(upperCase).type)
        assertEquals(WebRtcSessionDescription.Type.ANSWER, WebRtcPeerConnectionWrapper.toWebRtcSessionDescription(mixedCase).type)
    }

    @Test
    fun `toWebRtcSessionDescription throws for unknown type`() {
        val description = SessionDescription(type = "invalid", sdp = "v=0\r\ntest")

        assertThrows(WebRtcException::class.java) {
            WebRtcPeerConnectionWrapper.toWebRtcSessionDescription(description)
        }
    }

    @Test
    fun `fromWebRtcSessionDescription maps offer correctly`() {
        val webRtcSdp = WebRtcSessionDescription(WebRtcSessionDescription.Type.OFFER, "v=0\r\ntest-sdp")

        val description = WebRtcPeerConnectionWrapper.fromWebRtcSessionDescription(webRtcSdp)

        assertEquals("offer", description.type)
        assertEquals("v=0\r\ntest-sdp", description.sdp)
    }

    @Test
    fun `fromWebRtcSessionDescription maps answer correctly`() {
        val webRtcSdp = WebRtcSessionDescription(WebRtcSessionDescription.Type.ANSWER, "v=0\r\nanswer-sdp")

        val description = WebRtcPeerConnectionWrapper.fromWebRtcSessionDescription(webRtcSdp)

        assertEquals("answer", description.type)
        assertEquals("v=0\r\nanswer-sdp", description.sdp)
    }

    @Test
    fun `toWebRtcIceCandidate maps correctly`() {
        val candidate = IceCandidate(
            sdpMid = "0",
            sdpMLineIndex = 1,
            candidate = "candidate:123 1 udp 2122260223 192.168.1.1 54321 typ host"
        )

        val webRtcCandidate = WebRtcPeerConnectionWrapper.toWebRtcIceCandidate(candidate)

        assertEquals("0", webRtcCandidate.sdpMid)
        assertEquals(1, webRtcCandidate.sdpMLineIndex)
        assertEquals("candidate:123 1 udp 2122260223 192.168.1.1 54321 typ host", webRtcCandidate.sdp)
    }

    @Test
    fun `toWebRtcIceCandidate handles null sdpMid`() {
        val candidate = IceCandidate(
            sdpMid = null,
            sdpMLineIndex = 0,
            candidate = "candidate:456 1 udp 2122260223 10.0.0.1 12345 typ host"
        )

        val webRtcCandidate = WebRtcPeerConnectionWrapper.toWebRtcIceCandidate(candidate)

        assertEquals(null, webRtcCandidate.sdpMid)
        assertEquals(0, webRtcCandidate.sdpMLineIndex)
    }

    @Test
    fun `fromWebRtcIceCandidate maps correctly`() {
        val webRtcCandidate = WebRtcIceCandidate(
            "audio",
            2,
            "candidate:789 1 tcp 1518280447 192.168.1.1 9 typ host"
        )

        val candidate = WebRtcPeerConnectionWrapper.fromWebRtcIceCandidate(webRtcCandidate)

        assertEquals("audio", candidate.sdpMid)
        assertEquals(2, candidate.sdpMLineIndex)
        assertEquals("candidate:789 1 tcp 1518280447 192.168.1.1 9 typ host", candidate.candidate)
    }

    @Test
    fun `roundtrip SessionDescription preserves data`() {
        val original = SessionDescription(type = "offer", sdp = "v=0\r\no=- 123 2 IN IP4 127.0.0.1")

        val webRtcSdp = WebRtcPeerConnectionWrapper.toWebRtcSessionDescription(original)
        val roundTripped = WebRtcPeerConnectionWrapper.fromWebRtcSessionDescription(webRtcSdp)

        assertEquals(original.type, roundTripped.type)
        assertEquals(original.sdp, roundTripped.sdp)
    }

    @Test
    fun `roundtrip IceCandidate preserves data`() {
        val original = IceCandidate(
            sdpMid = "video",
            sdpMLineIndex = 1,
            candidate = "candidate:abc 1 udp 2122260223 203.0.113.1 50000 typ srflx"
        )

        val webRtcCandidate = WebRtcPeerConnectionWrapper.toWebRtcIceCandidate(original)
        val roundTripped = WebRtcPeerConnectionWrapper.fromWebRtcIceCandidate(webRtcCandidate)

        assertEquals(original.sdpMid, roundTripped.sdpMid)
        assertEquals(original.sdpMLineIndex, roundTripped.sdpMLineIndex)
        assertEquals(original.candidate, roundTripped.candidate)
    }
}
