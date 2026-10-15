package com.androidremote.app.mdm

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class UpdateBackoffTest {
    private val min = 60_000L

    @Test
    fun `a package that never failed may be installed`() {
        val b = UpdateBackoff(baseMs = 5 * min, maxMs = 360 * min)
        assertTrue(b.mayAttempt("com.player", 7, now = 0))
    }

    @Test
    fun `each failure doubles the wait for that package and version, up to the cap`() {
        val b = UpdateBackoff(baseMs = 5 * min, maxMs = 360 * min)
        var now = 0L
        val waits = mutableListOf<Long>()
        repeat(9) {
            b.recordFailure("com.player", 7, now)
            assertFalse(b.mayAttempt("com.player", 7, now + 1))
            val next = b.nextAttemptAt("com.player", 7)!!
            waits += (next - now) / min
            assertTrue(b.mayAttempt("com.player", 7, next))
            now = next
        }
        assertEquals(listOf(5L, 10, 20, 40, 80, 160, 320, 360, 360), waits)
    }

    @Test
    fun `other packages are not held back`() {
        val b = UpdateBackoff(baseMs = 5 * min, maxMs = 360 * min)
        b.recordFailure("com.player", 7, 0)
        assertTrue(b.mayAttempt("com.other", 3, 1))
    }

    @Test
    fun `a newer version on the server is tried at once`() {
        val b = UpdateBackoff(baseMs = 5 * min, maxMs = 360 * min)
        b.recordFailure("com.player", 7, 0)
        b.recordFailure("com.player", 7, 5 * min)
        assertTrue(b.mayAttempt("com.player", 8, 5 * min + 1))
        b.recordFailure("com.player", 8, 5 * min + 1)
        assertEquals(5 * min + 1 + 5 * min, b.nextAttemptAt("com.player", 8))
    }

    @Test
    fun `success clears the backoff`() {
        val b = UpdateBackoff(baseMs = 5 * min, maxMs = 360 * min)
        b.recordFailure("com.player", 7, 0)
        b.recordSuccess("com.player")
        assertTrue(b.mayAttempt("com.player", 7, 1))
        assertEquals(null, b.nextAttemptAt("com.player", 7))
    }

    @Test
    fun `huge failure counts do not overflow`() {
        val b = UpdateBackoff(baseMs = 5 * min, maxMs = 360 * min)
        repeat(200) { b.recordFailure("com.player", 7, 0) }
        assertEquals(360 * min, b.nextAttemptAt("com.player", 7))
    }
}
