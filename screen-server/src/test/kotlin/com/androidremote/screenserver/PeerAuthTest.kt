package com.androidremote.screenserver

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class PeerAuthTest {

    @Test
    fun `peer with the expected uid is accepted`() {
        assertTrue(PeerAuth.isAllowed(peerUid = 10123, expectedUid = 10123))
    }

    @Test
    fun `peer with another uid is rejected`() {
        assertFalse(PeerAuth.isAllowed(peerUid = 10456, expectedUid = 10123))
        assertFalse(PeerAuth.isAllowed(peerUid = 0, expectedUid = 10123))
        assertFalse(PeerAuth.isAllowed(peerUid = 2000, expectedUid = 10123))
    }

    @Test
    fun `unknown peer credentials are rejected`() {
        assertFalse(PeerAuth.isAllowed(peerUid = null, expectedUid = 10123))
        assertFalse(PeerAuth.isAllowed(peerUid = -1, expectedUid = 10123))
    }

    @Test
    fun `fails closed when no expected uid was configured`() {
        assertFalse(PeerAuth.isAllowed(peerUid = 10123, expectedUid = null))
        assertFalse(PeerAuth.isAllowed(peerUid = 0, expectedUid = null))
    }

    @Test
    fun `expected uid is parsed from -u argument`() {
        assertEquals(10123, PeerAuth.parseExpectedUid(arrayOf("-n", "x", "-u", "10123")))
        assertEquals(null, PeerAuth.parseExpectedUid(arrayOf("-n", "x")))
        assertEquals(null, PeerAuth.parseExpectedUid(arrayOf("-u", "abc")))
        assertEquals(null, PeerAuth.parseExpectedUid(arrayOf("-u", "-5")))
        assertEquals(null, PeerAuth.parseExpectedUid(arrayOf("-u")))
    }
}
