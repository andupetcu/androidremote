package com.androidremote.feature.input

import com.google.common.truth.Truth.assertThat
import org.junit.jupiter.api.Test

class ShellProbeTest {

    private class Fixture(
        var main: Boolean = false,
        var now: Long = 0L,
        var execResults: MutableMap<List<String>, Int?> = mutableMapOf()
    ) {
        val execCalls = mutableListOf<List<String>>()
        val pending = mutableListOf<Runnable>()
        val probe = ShellProbe(
            exec = { argv -> execCalls += argv; execResults[argv] },
            isMainThread = { main },
            clock = { now },
            background = { pending += it },
            retryAfterMs = 30_000L
        )
    }

    private val suUid = listOf("su", "0", "id")
    private val inputRoot = listOf("su", "0", "input")
    private val inputPlain = listOf("input")

    @Test
    fun `probe on main thread does not exec, schedules background work`() {
        val f = Fixture(main = true)
        assertThat(f.probe.isAvailable()).isFalse()
        assertThat(f.execCalls).isEmpty()
        assertThat(f.pending).hasSize(1)
        // a second call while in flight does not schedule another
        f.probe.isAvailable()
        assertThat(f.pending).hasSize(1)
    }

    @Test
    fun `background probe result becomes visible`() {
        val f = Fixture(main = true)
        f.execResults[suUid] = 0
        f.execResults[inputRoot] = 1
        f.probe.isAvailable()
        f.pending.single().run()
        assertThat(f.probe.isAvailable()).isTrue()
        assertThat(f.probe.rootMode).isEqualTo(RootMode.SU_UID)
    }

    @Test
    fun `off-main probe runs synchronously and caches success`() {
        val f = Fixture(main = false)
        f.execResults[inputPlain] = 1
        assertThat(f.probe.isAvailable()).isTrue()
        val calls = f.execCalls.size
        assertThat(f.probe.isAvailable()).isTrue()
        assertThat(f.execCalls).hasSize(calls)
    }

    @Test
    fun `failed probe is retried after the retry interval, not cached forever`() {
        val f = Fixture(main = false)
        // nothing works
        assertThat(f.probe.isAvailable()).isFalse()
        val callsAfterFirst = f.execCalls.size
        f.now = 10_000
        assertThat(f.probe.isAvailable()).isFalse()
        assertThat(f.execCalls).hasSize(callsAfterFirst) // still within backoff

        // su appears later
        f.execResults[suUid] = 0
        f.execResults[inputRoot] = 1
        f.now = 40_000
        assertThat(f.probe.isAvailable()).isTrue()
        assertThat(f.execCalls.size).isGreaterThan(callsAfterFirst)
    }

    @Test
    fun `falls back to su dash c`() {
        val f = Fixture(main = false)
        f.execResults[listOf("su", "-c", "id")] = 0
        f.execResults[listOf("su", "-c", "input")] = 1
        assertThat(f.probe.isAvailable()).isTrue()
        assertThat(f.probe.rootMode).isEqualTo(RootMode.SU_C)
    }
}
