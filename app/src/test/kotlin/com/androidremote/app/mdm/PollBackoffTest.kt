package com.androidremote.app.mdm

import com.androidremote.app.api.CommandApiErrorType
import com.androidremote.app.api.CommandApiException
import com.androidremote.app.testsupport.LogStub
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class PollBackoffTest {
    @BeforeEach fun setUp() = LogStub.install()
    @AfterEach fun tearDown() = LogStub.uninstall()

    @Test
    fun `delay grows exponentially from the base and caps at 5 minutes`() {
        val b = PollBackoff(baseMs = 10_000, maxMs = 300_000, random = { 0.0 })
        val seq = (0..8).map { b.delayAfterFailures(it) }
        assertEquals(listOf(10_000L, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000, 300_000), seq)
    }

    @Test
    fun `huge failure counts do not overflow`() {
        val b = PollBackoff(10_000, 300_000, { 0.0 })
        assertEquals(300_000L, b.delayAfterFailures(10_000))
    }

    @Test
    fun `jitter only shortens the delay and never exceeds the cap`() {
        val low = PollBackoff(10_000, 300_000, { 1.0 })
        val high = PollBackoff(10_000, 300_000, { 0.0 })
        for (n in 0..12) {
            assertTrue(low.delayAfterFailures(n) < high.delayAfterFailures(n))
            assertTrue(low.delayAfterFailures(n) >= high.delayAfterFailures(n) * 0.79)
            assertTrue(high.delayAfterFailures(n) <= 300_000)
        }
    }

    @Test
    fun `loop backs off on failures and resets after a success`() = runTest {
        val sleeps = mutableListOf<Long>()
        val outcomes = ArrayDeque(listOf("fail", "fail", "fail", "ok", "fail", "stop"))
        var running = true
        runPollLoop(
            baseMs = 10_000,
            backoff = PollBackoff(10_000, 300_000, { 0.0 }),
            isActive = { running },
            sleep = { sleeps += it },
            onEnrollmentInvalid = {},
            pollOnce = {
                when (outcomes.removeFirst()) {
                    "fail" -> throw CommandApiException("x", CommandApiErrorType.SERVER_ERROR)
                    "stop" -> running = false
                    else -> Unit
                }
            }
        )
        assertEquals(listOf(20_000L, 40_000, 80_000, 10_000, 20_000), sleeps.take(5))
    }

    @Test
    fun `401 or 404 stops the loop and surfaces the state`() = runTest {
        for (t in listOf(CommandApiErrorType.UNAUTHORIZED, CommandApiErrorType.DEVICE_NOT_FOUND)) {
            var polls = 0
            var surfaced: CommandApiException? = null
            runPollLoop(
                baseMs = 10_000,
                backoff = PollBackoff(10_000, 300_000, { 0.0 }),
                isActive = { true },
                sleep = {},
                onEnrollmentInvalid = { surfaced = it },
                pollOnce = { polls++; throw CommandApiException("gone", t) }
            )
            assertEquals(1, polls)
            assertEquals(t, surfaced!!.errorType)
        }
    }
}
