package com.androidremote.app.mdm

import org.junit.Assert.assertNull
import org.junit.Assert.assertEquals
import org.junit.Test

class RemoteDesktopGateTest {
    @Test
    fun `START_REMOTE is refused with a clear message when root is unavailable`() {
        assertEquals("Remote desktop requires a rooted device", RemoteDesktopGate.failureMessage(rooted = false))
    }

    @Test
    fun `START_REMOTE is allowed on a rooted device`() {
        assertNull(RemoteDesktopGate.failureMessage(rooted = true))
    }
}
