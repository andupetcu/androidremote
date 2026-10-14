package com.androidremote.app.mdm.telemetry

import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class TelemetryBufferTest {
    @TempDir lateinit var dir: File

    private fun buf(cap: Int = 1000) = SampleRingBuffer(File(dir, "t.jsonl"), cap)

    @Test
    fun `ring keeps the newest 1000 samples in order`() {
        val b = buf()
        for (i in 1..1005) b.append("""{"n":$i}""")
        assertEquals(1000, b.size)
        val all = b.peek(2000)
        assertEquals("""{"n":6}""", all.first())
        assertEquals("""{"n":1005}""", all.last())
        assertEquals((6..1005).map { """{"n":$it}""" }, all)
    }

    @Test
    fun `peek and drop take from the oldest end`() {
        val b = buf(10)
        for (i in 1..5) b.append("s$i")
        assertEquals(listOf("s1", "s2"), b.peek(2))
        b.drop(2)
        assertEquals(listOf("s3", "s4", "s5"), b.peek(10))
        assertEquals(3, b.size)
    }

    @Test
    fun `contents survive a new instance and a corrupt blank line is skipped`() {
        val f = File(dir, "t.jsonl")
        SampleRingBuffer(f, 10).apply { append("a"); append("b") }
        f.appendText("\n\n")
        assertEquals(listOf("a", "b"), SampleRingBuffer(f, 10).peek(10))
    }

    private class Fake(val batch: ArrayDeque<BatchOutcome>, val singleOk: Boolean = true) {
        val batches = mutableListOf<List<String>>()
        val singles = mutableListOf<String>()
        suspend fun sendBatch(l: List<String>): BatchOutcome { batches += l; return batch.removeFirstOrNull() ?: BatchOutcome.OK }
        suspend fun sendSingle(s: String): Boolean { singles += s; return singleOk }
    }

    @Test
    fun `failed flush keeps every sample and a retry sends them in order`() = runTest {
        val b = buf(); for (i in 1..5) b.append("s$i")
        val fake = Fake(ArrayDeque(listOf(BatchOutcome.FAILED, BatchOutcome.OK)))
        val fl = TelemetryFlusher(b, fake::sendBatch, fake::sendSingle, batchSize = 100)
        assertFalse(fl.flush())
        assertEquals(5, b.size)
        assertTrue(fl.flush())
        assertEquals(0, b.size)
        assertEquals(listOf("s1", "s2", "s3", "s4", "s5"), fake.batches.last())
    }

    @Test
    fun `backlog is sent in batches`() = runTest {
        val b = buf(); for (i in 1..250) b.append("s$i")
        val fake = Fake(ArrayDeque())
        assertTrue(TelemetryFlusher(b, fake::sendBatch, fake::sendSingle, batchSize = 100).flush())
        assertEquals(listOf(100, 100, 50), fake.batches.map { it.size })
        assertEquals(0, b.size)
    }

    @Test
    fun `404 from the batch endpoint falls back to single posts and is remembered`() = runTest {
        val b = buf(); for (i in 1..3) b.append("s$i")
        val fake = Fake(ArrayDeque(listOf(BatchOutcome.NOT_FOUND)))
        val fl = TelemetryFlusher(b, fake::sendBatch, fake::sendSingle, batchSize = 100)
        assertTrue(fl.flush())
        assertEquals(listOf("s1", "s2", "s3"), fake.singles)
        assertEquals(0, b.size)
        b.append("s4"); b.append("s5")
        assertTrue(fl.flush())
        assertEquals(1, fake.batches.size) // batch endpoint not tried again
        assertEquals(5, fake.singles.size)
    }

    @Test
    fun `single failure during fallback keeps the unsent samples`() = runTest {
        val b = buf(); for (i in 1..3) b.append("s$i")
        val fake = Fake(ArrayDeque(listOf(BatchOutcome.NOT_FOUND)), singleOk = false)
        assertFalse(TelemetryFlusher(b, fake::sendBatch, fake::sendSingle).flush())
        assertEquals(3, b.size)
    }

    @Test
    fun `report interval defaults to 60 s, honours the server and clamps`() {
        assertEquals(60_000L, ReportInterval.from(null))
        assertEquals(60_000L, ReportInterval.from(0))
        assertEquals(120_000L, ReportInterval.from(120_000))
        assertEquals(15_000L, ReportInterval.from(100))
        assertEquals(3_600_000L, ReportInterval.from(99_999_999))
    }

    @Test
    fun `schedule is due after the interval and follows a changed interval`() {
        val s = ReportSchedule()
        assertTrue(s.isDue(0))
        s.markReported(1_000)
        assertFalse(s.isDue(60_999))
        assertTrue(s.isDue(61_000))
        s.update(300_000)
        assertFalse(s.isDue(200_000))
        assertTrue(s.isDue(301_000))
    }

    private fun fix(age: Long, acc: Float, now: Long = 10_000_000) = LocationFix(1.0, 2.0, acc, now - age)

    @Test
    fun `location older than 15 minutes is dropped, newer is kept`() {
        val now = 10_000_000L
        assertNull(LocationPolicy.select(listOf(fix(15 * 60_000 + 1, 5f)), now))
        assertEquals(5f, LocationPolicy.select(listOf(fix(15 * 60_000, 5f)), now)!!.accuracy)
        assertNull(LocationPolicy.select(emptyList(), now))
    }

    @Test
    fun `most accurate fresh fix wins and stale ones are ignored`() {
        val now = 10_000_000L
        val picked = LocationPolicy.select(listOf(fix(1000, 50f), fix(2000, 8f), fix(20 * 60_000, 1f)), now)
        assertEquals(8f, picked!!.accuracy)
    }

    @Test
    fun `location is requested only when enabled and permission granted`() {
        assertTrue(LocationPolicy.shouldRequest(enabled = true, granted = true))
        assertFalse(LocationPolicy.shouldRequest(enabled = true, granted = false))
        assertFalse(LocationPolicy.shouldRequest(enabled = false, granted = true))
    }
}
