package com.androidremote.transport

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class PeerConnectionTest {

    private lateinit var mockFactory: MockPeerConnectionFactory
    private lateinit var peerConnection: PeerConnectionWrapper

    @BeforeEach
    fun setup() {
        mockFactory = MockPeerConnectionFactory()
        peerConnection = PeerConnectionWrapper(mockFactory)
    }

    @Test
    fun `creates offer successfully`() = runTest {
        val offer = peerConnection.createOffer()

        assertNotNull(offer)
        assertEquals("offer", offer.type)
        assertTrue(offer.sdp.isNotEmpty())
    }

    @Test
    fun `creates answer after setting remote offer`() = runTest {
        val remoteOffer = SessionDescription(type = "offer", sdp = "v=0\r\nremote-offer-sdp")

        peerConnection.setRemoteDescription(remoteOffer)
        val answer = peerConnection.createAnswer()

        assertNotNull(answer)
        assertEquals("answer", answer.type)
    }

    @Test
    fun `sets local description`() = runTest {
        val offer = peerConnection.createOffer()

        peerConnection.setLocalDescription(offer)

        assertEquals(offer.sdp, mockFactory.mockConnection.localDescription?.sdp)
    }

    @Test
    fun `sets remote description`() = runTest {
        val answer = SessionDescription(type = "answer", sdp = "v=0\r\nremote-answer-sdp")

        peerConnection.setRemoteDescription(answer)

        assertEquals(answer.sdp, mockFactory.mockConnection.remoteDescription?.sdp)
    }

    @Test
    fun `adds ICE candidate`() = runTest {
        val candidate = IceCandidate(
            sdpMid = "0",
            sdpMLineIndex = 0,
            candidate = "candidate:123 1 udp 2122260223 192.168.1.1 54321 typ host"
        )

        peerConnection.addIceCandidate(candidate)

        assertTrue(mockFactory.mockConnection.addedCandidates.isNotEmpty())
        assertEquals(candidate.candidate, mockFactory.mockConnection.addedCandidates.first().candidate)
    }

    @Test
    fun `emits ICE candidates when gathered`() = runTest {
        // Setup: create offer to trigger ICE gathering
        peerConnection.createOffer()
        peerConnection.setLocalDescription(SessionDescription("offer", "v=0\r\nsdp"))

        // Simulate ICE candidate being gathered
        mockFactory.mockConnection.simulateIceCandidate(
            IceCandidate(
                candidate = "candidate:456 1 udp 2122260223 10.0.0.1 12345 typ host",
                sdpMid = "0",
                sdpMLineIndex = 0
            )
        )

        val candidate = withTimeout(1000) {
            peerConnection.iceCandidates.first()
        }
        assertEquals("candidate:456 1 udp 2122260223 10.0.0.1 12345 typ host", candidate.candidate)
    }

    @Test
    fun `reports connection state changes`() = runTest {
        // Initially disconnected
        assertEquals(ConnectionState.NEW, peerConnection.connectionState.value)

        // Simulate connection state change
        mockFactory.mockConnection.simulateConnectionStateChange(ConnectionState.CONNECTING)

        val state = withTimeout(1000) {
            peerConnection.connectionState.first { it == ConnectionState.CONNECTING }
        }
        assertEquals(ConnectionState.CONNECTING, state)
    }

    @Test
    fun `closes connection`() = runTest {
        peerConnection.createOffer()

        peerConnection.close()

        assertTrue(mockFactory.mockConnection.isClosed)
    }
}

/**
 * Mock peer connection factory for testing.
 */
class MockPeerConnectionFactory : PeerConnectionFactoryInterface {
    val mockConnection = MockNativePeerConnection()

    override fun createPeerConnection(
        config: PeerConnectionConfig,
        observer: PeerConnectionObserver
    ): NativePeerConnection {
        mockConnection.observer = observer
        return mockConnection
    }
}

/**
 * Mock native peer connection for testing.
 */
class MockNativePeerConnection : NativePeerConnection {
    var observer: PeerConnectionObserver? = null
    var localDescription: SessionDescription? = null
    var remoteDescription: SessionDescription? = null
    val addedCandidates = mutableListOf<IceCandidate>()
    var isClosed = false
    private var offerCounter = 0

    override suspend fun createOffer(): SessionDescription {
        offerCounter++
        return SessionDescription("offer", "v=0\r\nmock-offer-sdp-$offerCounter")
    }

    override suspend fun createAnswer(): SessionDescription {
        return SessionDescription("answer", "v=0\r\nmock-answer-sdp")
    }

    override suspend fun setLocalDescription(description: SessionDescription) {
        localDescription = description
    }

    override suspend fun setRemoteDescription(description: SessionDescription) {
        remoteDescription = description
    }

    override suspend fun addIceCandidate(candidate: IceCandidate) {
        addedCandidates.add(candidate)
    }

    override fun close() {
        isClosed = true
    }

    fun simulateIceCandidate(candidate: IceCandidate) {
        observer?.onIceCandidate(candidate)
    }

    fun simulateConnectionStateChange(state: ConnectionState) {
        observer?.onConnectionStateChange(state)
    }

    fun simulateDataChannel(channel: DataChannelInterface) {
        observer?.onDataChannel(channel)
    }
}
