package com.androidremote.app.mdm

import android.content.Context
import org.robolectric.RuntimeEnvironment
import com.androidremote.app.testsupport.TestApplication
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = TestApplication::class, sdk = [34])
class CommandStateStoreTest {
    private fun prefs() = RuntimeEnvironment.getApplication()
        .getSharedPreferences("cmd_state_test", Context.MODE_PRIVATE)

    @Test
    fun `ring keeps only the last 200 command ids`() {
        val store = PrefsCommandStateStore(prefs())
        for (i in 1..250) store.record(StoredCommand("c$i", "completed", null))
        assertNull(store.find("c1"))
        assertNull(store.find("c50"))
        assertNotNull(store.find("c51"))
        assertNotNull(store.find("c250"))
    }

    @Test
    fun `state survives a new store instance`() {
        val p = prefs()
        PrefsCommandStateStore(p).apply {
            record(StoredCommand("a", "failed", "why"))
            addPendingAck(PendingAck("a", "failed", "why"))
        }
        val again = PrefsCommandStateStore(p)
        assertEquals(StoredCommand("a", "failed", "why"), again.find("a"))
        assertEquals(listOf(PendingAck("a", "failed", "why")), again.pendingAcks())
        again.removePendingAck("a", "failed")
        assertEquals(0, PrefsCommandStateStore(p).pendingAcks().size)
    }

    @Test
    fun `recording the same id again updates it in place`() {
        val store = PrefsCommandStateStore(prefs())
        store.record(StoredCommand("a", "executing", null))
        store.record(StoredCommand("a", "completed", null))
        assertEquals("completed", store.find("a")!!.state)
    }

    @Test
    fun `corrupt stored json is tolerated`() {
        val p = prefs()
        p.edit().putString("state", "{not json").commit()
        assertNull(PrefsCommandStateStore(p).find("a"))
    }
}
