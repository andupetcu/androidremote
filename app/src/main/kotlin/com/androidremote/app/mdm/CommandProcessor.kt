package com.androidremote.app.mdm

import android.util.Log
import com.androidremote.app.api.AckResult
import com.androidremote.app.api.CommandAcks
import com.androidremote.app.api.CommandStatus
import com.androidremote.app.api.DeviceCommand
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import java.util.concurrent.ConcurrentHashMap

/**
 * Runs one command with the lifecycle of contract C5:
 * ack executing, run under a timeout, ack completed or failed, and never run a command id twice.
 * Acks that cannot be delivered are queued in the [store] and resent by [flushPendingAcks].
 */
class CommandProcessor(
    private val acks: CommandAcks,
    private val store: CommandStateStore,
    private val handler: suspend (DeviceCommand) -> CommandResult,
    private val timeoutMs: (DeviceCommand) -> Long = { timeoutMsFor(it.type) }
) {
    companion object {
        private const val TAG = "CommandProcessor"
        const val INSTALL_TIMEOUT_MS = 600_000L
        const val DEFAULT_TIMEOUT_MS = 120_000L

        /** Commands that take the device down. A restart in the middle of them is their success. */
        private val TERMINAL_TYPES = setOf("REBOOT", "WIPE")

        /** Commands that wait on the package installer. They run off the poll loop, one at a time. */
        val LONG_RUNNING_TYPES = setOf("INSTALL_APK", "UNINSTALL_APP")

        fun timeoutMsFor(type: String): Long = if (type == "INSTALL_APK") INSTALL_TIMEOUT_MS else DEFAULT_TIMEOUT_MS
    }

    private val inFlight = ConcurrentHashMap.newKeySet<String>()
    private val serialLock = Mutex()

    /**
     * @param serialize run behind a lock so that long-running commands (installs) execute one at a time
     *   without holding up other commands.
     */
    suspend fun process(command: DeviceCommand, serialize: Boolean = false) {
        if (!inFlight.add(command.id)) {
            Log.d(TAG, "Command ${command.id} is already being processed, skipping redelivery")
            return
        }
        try {
            if (serialize) serialLock.withLock { run(command) } else run(command)
        } finally {
            inFlight.remove(command.id)
        }
    }

    private suspend fun run(command: DeviceCommand) {
        val previous = store.find(command.id)
        if (previous != null) {
            reackDuplicate(command, previous)
            return
        }

        when (acks.ack(command.id, CommandStatus.executing, null)) {
            AckResult.REJECTED -> {
                Log.w(TAG, "Server rejected executing ack for ${command.id}; not running it")
                return
            }
            else -> Unit // OK, or the network is down: run it anyway, the final ack will be queued
        }

        store.record(StoredCommand(command.id, "executing"))
        val result = execute(command)
        val state = if (result.success) "completed" else "failed"
        store.record(StoredCommand(command.id, state, result.error))
        sendFinal(command.id, state, result.error)
    }

    private suspend fun execute(command: DeviceCommand): CommandResult {
        val limit = timeoutMs(command)
        return try {
            withTimeout(limit) { handler(command) }
        } catch (e: TimeoutCancellationException) {
            Log.w(TAG, "Command ${command.id} (${command.type}) timed out after ${limit}ms")
            CommandResult.failure("Command timed out after ${limit / 1000}s")
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.e(TAG, "Command ${command.id} threw", e)
            CommandResult.failure("Exception: ${e.message}")
        }
    }

    private suspend fun reackDuplicate(command: DeviceCommand, previous: StoredCommand) {
        Log.i(TAG, "Duplicate command ${command.id} (${previous.state}); not executing again")
        val (state, error) = when (previous.state) {
            "executing" ->
                if (command.type in TERMINAL_TYPES) "completed" to null
                else "failed" to "Interrupted before a result was recorded (device restarted or process killed)"
            else -> previous.state to previous.error
        }
        if (state != previous.state) store.record(StoredCommand(command.id, state, error))
        sendFinal(command.id, state, error)
    }

    private suspend fun sendFinal(id: String, state: String, error: String?) {
        val status = if (state == "completed") CommandStatus.completed else CommandStatus.failed
        when (acks.ack(id, status, error)) {
            AckResult.OK, AckResult.REJECTED -> Unit
            AckResult.UNAUTHORIZED, AckResult.RETRY_LATER -> {
                Log.w(TAG, "Ack $status for $id not delivered; queued for the next poll")
                store.addPendingAck(PendingAck(id, status.name, error))
            }
        }
    }

    /** Resend queued acks. Stops at the first one that still fails. */
    suspend fun flushPendingAcks() {
        for (pending in store.pendingAcks()) {
            val status = CommandStatus.valueOf(pending.status)
            when (acks.ack(pending.commandId, status, pending.error)) {
                AckResult.OK, AckResult.REJECTED -> store.removePendingAck(pending.commandId, pending.status)
                AckResult.UNAUTHORIZED, AckResult.RETRY_LATER -> return
            }
        }
    }
}
