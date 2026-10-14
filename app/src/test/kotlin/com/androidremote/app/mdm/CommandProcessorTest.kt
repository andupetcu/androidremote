package com.androidremote.app.mdm

import com.androidremote.app.api.AckResult
import com.androidremote.app.api.CommandAcks
import com.androidremote.app.api.CommandStatus
import com.androidremote.app.api.DeviceCommand
import com.androidremote.app.testsupport.LogStub
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class CommandProcessorTest {
    @BeforeEach fun setUp() = LogStub.install()
    @AfterEach fun tearDown() = LogStub.uninstall()

    data class Ack(val id: String, val status: CommandStatus, val error: String?)

    class FakeAcks : CommandAcks {
        val log = mutableListOf<Ack>()
        var script: (Ack) -> AckResult = { AckResult.OK }
        override suspend fun ack(commandId: String, status: CommandStatus, error: String?): AckResult {
            val a = Ack(commandId, status, error)
            log += a
            return script(a)
        }
    }

    private fun cmd(id: String, type: String = "LOCK") =
        DeviceCommand(id, "d1", type, JsonObject(emptyMap()), "delivered", 0L)

    @Test
    fun `executes then acks executing and completed`() = runTest {
        val acks = FakeAcks()
        var runs = 0
        val p = CommandProcessor(acks, MemoryCommandStateStore(), { runs++; CommandResult.success() })
        p.process(cmd("a"))
        assertEquals(1, runs)
        assertEquals(listOf(CommandStatus.executing, CommandStatus.completed), acks.log.map { it.status })
    }

    @Test
    fun `a failed handler result acks failed with the message`() = runTest {
        val acks = FakeAcks()
        val p = CommandProcessor(acks, MemoryCommandStateStore(), { CommandResult.failure("nope") })
        p.process(cmd("a"))
        assertEquals(Ack("a", CommandStatus.failed, "nope"), acks.log.last())
    }

    @Test
    fun `a duplicate command is not re-executed and its stored result is re-acked`() = runTest {
        val acks = FakeAcks()
        val store = MemoryCommandStateStore()
        var runs = 0
        val p = CommandProcessor(acks, store, { runs++; CommandResult.failure("bad") })
        p.process(cmd("a"))
        acks.log.clear()

        p.process(cmd("a"))   // redelivered after lease expiry

        assertEquals(1, runs)
        assertEquals(listOf(Ack("a", CommandStatus.failed, "bad")), acks.log)
    }

    @Test
    fun `duplicate survives a new processor instance (persistent store)`() = runTest {
        val store = MemoryCommandStateStore()
        var runs = 0
        CommandProcessor(FakeAcks(), store, { runs++; CommandResult.success() }).process(cmd("a"))
        val acks2 = FakeAcks()
        CommandProcessor(acks2, store, { runs++; CommandResult.success() }).process(cmd("a"))
        assertEquals(1, runs)
        assertEquals(CommandStatus.completed, acks2.log.single().status)
    }

    @Test
    fun `command interrupted mid-run is acked failed on redelivery, reboot is acked completed`() = runTest {
        val store = MemoryCommandStateStore()
        store.record(StoredCommand("x", "executing", null))
        store.record(StoredCommand("r", "executing", null))
        val acks = FakeAcks()
        var runs = 0
        val p = CommandProcessor(acks, store, { runs++; CommandResult.success() })
        p.process(cmd("x", "INSTALL_APK"))
        p.process(cmd("r", "REBOOT"))
        assertEquals(0, runs)
        assertEquals(CommandStatus.failed, acks.log.first { it.id == "x" }.status)
        assertEquals(CommandStatus.completed, acks.log.first { it.id == "r" }.status)
    }

    @Test
    fun `executing ack rejected by server means the command is not run`() = runTest {
        val acks = FakeAcks().apply { script = { if (it.status == CommandStatus.executing) AckResult.REJECTED else AckResult.OK } }
        var runs = 0
        CommandProcessor(acks, MemoryCommandStateStore(), { runs++; CommandResult.success() }).process(cmd("a"))
        assertEquals(0, runs)
    }

    @Test
    fun `executing ack failing on network still runs the command`() = runTest {
        val acks = FakeAcks().apply { script = { if (it.status == CommandStatus.executing) AckResult.RETRY_LATER else AckResult.OK } }
        var runs = 0
        CommandProcessor(acks, MemoryCommandStateStore(), { runs++; CommandResult.success() }).process(cmd("a"))
        assertEquals(1, runs)
    }

    @Test
    fun `failed final ack is queued and resent on the next flush`() = runTest {
        val store = MemoryCommandStateStore()
        val acks = FakeAcks()
        var down = true
        acks.script = { if (down && it.status != CommandStatus.executing) AckResult.RETRY_LATER else AckResult.OK }
        val p = CommandProcessor(acks, store, { CommandResult.success() })
        p.process(cmd("a"))
        assertEquals(1, store.pendingAcks().size)

        down = false
        acks.log.clear()
        p.flushPendingAcks()

        assertEquals(listOf(Ack("a", CommandStatus.completed, null)), acks.log)
        assertTrue(store.pendingAcks().isEmpty())
    }

    @Test
    fun `flush stops at the first failure and keeps the queue`() = runTest {
        val store = MemoryCommandStateStore()
        store.addPendingAck(PendingAck("a", "completed", null))
        store.addPendingAck(PendingAck("b", "failed", "e"))
        val acks = FakeAcks().apply { script = { AckResult.RETRY_LATER } }
        CommandProcessor(acks, store, { CommandResult.success() }).flushPendingAcks()
        assertEquals(1, acks.log.size)
        assertEquals(2, store.pendingAcks().size)
    }

    @Test
    fun `permanently rejected final ack is dropped, not queued`() = runTest {
        val store = MemoryCommandStateStore()
        val acks = FakeAcks().apply { script = { if (it.status == CommandStatus.completed) AckResult.REJECTED else AckResult.OK } }
        CommandProcessor(acks, store, { CommandResult.success() }).process(cmd("a"))
        assertTrue(store.pendingAcks().isEmpty())
    }

    @Test
    fun `a command that exceeds its timeout is reported failed`() = runTest {
        val acks = FakeAcks()
        val p = CommandProcessor(acks, MemoryCommandStateStore(), { delay(Long.MAX_VALUE); CommandResult.success() }, timeoutMs = { 120_000L })
        val job = async { p.process(cmd("a", "INSTALL_APK")) }
        advanceTimeBy(119_000); runCurrent()
        assertEquals(listOf(CommandStatus.executing), acks.log.map { it.status })
        advanceTimeBy(2_000); runCurrent()
        job.await()
        val last = acks.log.last()
        assertEquals(CommandStatus.failed, last.status)
        assertTrue(last.error!!.contains("timed out"), last.error)
    }

    @Test
    fun `timeouts are 10 minutes for install and 2 minutes for the rest`() {
        assertEquals(600_000L, CommandProcessor.timeoutMsFor("INSTALL_APK"))
        assertEquals(120_000L, CommandProcessor.timeoutMsFor("LOCK"))
        assertEquals(120_000L, CommandProcessor.timeoutMsFor("REBOOT"))
        assertEquals(120_000L, CommandProcessor.timeoutMsFor("UNINSTALL_APP"))
    }

    @Test
    fun `a stuck long-running command does not block a quick command, and a redelivery is not run twice`() = runTest {
        val acks = FakeAcks()
        val gate = CompletableDeferred<Unit>()
        var installRuns = 0
        val p = CommandProcessor(acks, MemoryCommandStateStore(), { c ->
            if (c.type == "INSTALL_APK") { installRuns++; gate.await() }
            CommandResult.success()
        })
        val install = async { p.process(cmd("i", "INSTALL_APK"), serialize = true) }
        runCurrent()
        val redelivered = async { p.process(cmd("i", "INSTALL_APK"), serialize = true) }
        p.process(cmd("l", "LOCK"))
        runCurrent()

        assertTrue(acks.log.any { it.id == "l" && it.status == CommandStatus.completed })
        assertEquals(1, installRuns)
        gate.complete(Unit)
        install.await(); redelivered.await()
        assertEquals(1, installRuns)
    }

    @Test
    fun `handler exception becomes failed`() = runTest {
        val acks = FakeAcks()
        CommandProcessor(acks, MemoryCommandStateStore(), { error("kaput") }).process(cmd("a"))
        assertEquals(CommandStatus.failed, acks.log.last().status)
        assertTrue(acks.log.last().error!!.contains("kaput"))
    }
}
