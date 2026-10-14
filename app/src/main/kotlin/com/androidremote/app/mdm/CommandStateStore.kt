package com.androidremote.app.mdm

import android.content.SharedPreferences
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** Result of a command the device has started or finished. state: executing | completed | failed. */
@Serializable
data class StoredCommand(val id: String, val state: String, val error: String? = null)

/** A status ack that could not be delivered and must be resent. */
@Serializable
data class PendingAck(val commandId: String, val status: String, val error: String? = null)

/**
 * Persistent record of executed commands (last 200) and of acks still to be delivered (contract C5).
 */
interface CommandStateStore {
    fun find(id: String): StoredCommand?
    fun record(command: StoredCommand)
    fun pendingAcks(): List<PendingAck>
    fun addPendingAck(ack: PendingAck)
    fun removePendingAck(commandId: String, status: String)
}

@Serializable
internal data class LedgerState(
    val commands: List<StoredCommand> = emptyList(),
    val acks: List<PendingAck> = emptyList()
)

/** Shared ring logic. Subclasses decide where the state lives. */
abstract class LedgerBackedStore : CommandStateStore {
    companion object {
        const val MAX_COMMANDS = 200
        const val MAX_PENDING_ACKS = 100
    }

    internal abstract fun load(): LedgerState
    internal abstract fun save(state: LedgerState)

    @Synchronized
    override fun find(id: String): StoredCommand? = load().commands.lastOrNull { it.id == id }

    @Synchronized
    override fun record(command: StoredCommand) {
        val s = load()
        val list = s.commands.filterNot { it.id == command.id } + command
        save(s.copy(commands = list.takeLast(MAX_COMMANDS)))
    }

    @Synchronized
    override fun pendingAcks(): List<PendingAck> = load().acks

    @Synchronized
    override fun addPendingAck(ack: PendingAck) {
        val s = load()
        val list = s.acks.filterNot { it.commandId == ack.commandId && it.status == ack.status } + ack
        save(s.copy(acks = list.takeLast(MAX_PENDING_ACKS)))
    }

    @Synchronized
    override fun removePendingAck(commandId: String, status: String) {
        val s = load()
        save(s.copy(acks = s.acks.filterNot { it.commandId == commandId && it.status == status }))
    }
}

class MemoryCommandStateStore : LedgerBackedStore() {
    private var state = LedgerState()
    override fun load() = state
    override fun save(state: LedgerState) { this.state = state }
}

/** SharedPreferences-backed store. Corrupt data is treated as empty. */
class PrefsCommandStateStore(private val prefs: SharedPreferences) : LedgerBackedStore() {
    private val json = Json { ignoreUnknownKeys = true }

    override fun load(): LedgerState {
        val raw = prefs.getString("state", null) ?: return LedgerState()
        return try {
            json.decodeFromString<LedgerState>(raw)
        } catch (e: Exception) {
            LedgerState()
        }
    }

    override fun save(state: LedgerState) {
        prefs.edit().putString("state", json.encodeToString(state)).commit()
    }
}
