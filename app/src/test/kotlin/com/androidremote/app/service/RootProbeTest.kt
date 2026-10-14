package com.androidremote.app.service

import com.google.common.truth.Truth.assertThat
import org.junit.Test

class RootProbeTest {
    private var now = 0L
    private var calls = 0

    private fun probe(result: () -> String?) = RootProbe(clock = { now }, runSu = { calls++; result() })

    @Test
    fun `uid 0 answer means root works`() {
        assertThat(probe { "uid=0(root) gid=0(root)" }.isRootWorking()).isTrue()
    }

    @Test
    fun `su missing or denied means no root`() {
        assertThat(probe { null }.isRootWorking()).isFalse()
        assertThat(probe { "uid=2000(shell)" }.isRootWorking()).isFalse()
        assertThat(probe { throw java.io.IOException("su: not found") }.isRootWorking()).isFalse()
    }

    @Test
    fun `positive answer is cached, negative is re-probed after a short time`() {
        val ok = probe { "uid=0(root)" }
        ok.isRootWorking(); ok.isRootWorking()
        assertThat(calls).isEqualTo(1)
        calls = 0
        val no = probe { null }
        no.isRootWorking(); no.isRootWorking()
        assertThat(calls).isEqualTo(1)
        now += 31_000
        no.isRootWorking()
        assertThat(calls).isEqualTo(2)
    }
}
