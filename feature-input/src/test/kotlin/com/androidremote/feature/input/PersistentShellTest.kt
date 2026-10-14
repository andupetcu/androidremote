package com.androidremote.feature.input

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Test

/** AR-06: one persistent shell, per-command timeout. Uses the host `sh` as the stand-in for `su`. */
class PersistentShellTest {

    private fun shell(timeoutMs: Long = 2000) =
        PersistentShell({ ProcessBuilder("sh").redirectErrorStream(true).start() }, timeoutMs)

    @Test
    fun `runs many commands in one process`() {
        val sh = shell()
        repeat(50) { assertTrue(sh.run(listOf("true")).isSuccess) }
        assertEquals(1, sh.launchCount)
        sh.close()
    }

    @Test
    fun `non zero exit is a failure and the shell stays usable`() {
        val sh = shell()
        assertTrue(sh.run(listOf("false")).isFailure)
        assertTrue(sh.run(listOf("true")).isSuccess)
        assertEquals(1, sh.launchCount)
        sh.close()
    }

    @Test
    fun `a hung command times out and the shell is restarted`() {
        val sh = shell(timeoutMs = 300)
        val started = System.nanoTime()
        val result = sh.run(listOf("sleep", "5"))
        val elapsedMs = (System.nanoTime() - started) / 1_000_000
        assertTrue(result.isFailure)
        assertTrue(elapsedMs < 2000, "timeout took ${elapsedMs}ms")
        assertTrue(sh.run(listOf("true")).isSuccess)
        assertEquals(2, sh.launchCount)
        sh.close()
    }

    @Test
    fun `a dead shell is restarted on the next command`() {
        val sh = shell()
        assertTrue(sh.run(listOf("exit", "3")).isFailure)
        assertTrue(sh.run(listOf("true")).isSuccess)
        assertEquals(2, sh.launchCount)
        sh.close()
    }

    @Test
    fun `arguments are quoted so text cannot inject a second command`() {
        val sh = shell()
        val marker = java.io.File.createTempFile("pshell", ".x").also { it.delete() }
        assertTrue(sh.run(listOf("echo", "hi; touch ${marker.absolutePath}")).isSuccess)
        assertFalse(marker.exists())
        sh.close()
    }

    @Test
    fun `launch failure is reported as a failure`() {
        val sh = PersistentShell({ throw java.io.IOException("no su") })
        assertTrue(sh.run(listOf("true")).isFailure)
    }
}
