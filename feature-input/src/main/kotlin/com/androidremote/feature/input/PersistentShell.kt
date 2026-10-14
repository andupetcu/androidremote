package com.androidremote.feature.input

import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * One long-lived shell process (normally a root shell) that executes `input` commands over
 * stdin, instead of forking `su` for every tap (AR-06). Commands run one at a time with a
 * per-command timeout; on a timeout or a dead process the shell is killed and restarted for
 * the next command.
 *
 * Callers must not invoke this on the Main thread (it blocks while the command runs).
 */
class PersistentShell(
    private val launcher: () -> Process,
    private val timeoutMs: Long = 5_000L
) {
    private class Session(val process: Process) {
        val lines = LinkedBlockingQueue<String>()
        val writer = process.outputStream.bufferedWriter()
        val reader = Thread({
            try {
                process.inputStream.bufferedReader().forEachLine { lines.put(it) }
            } catch (_: Exception) {
            }
            lines.put(EOF)
        }, "persistent-shell-reader").apply { isDaemon = true }

        init { reader.start() }

        fun kill() {
            try { process.destroyForcibly() } catch (_: Exception) {}
        }
    }

    private val lock = Any()
    private var session: Session? = null
    private var counter = 0L

    /** Number of times a shell process was started (for diagnostics and tests). */
    @Volatile var launchCount = 0
        private set

    /**
     * Run one command (argv, quoted for the shell). Success means exit code 0.
     */
    fun run(argv: List<String>): Result<Unit> = synchronized(lock) { runLocked(argv) }

    private fun runLocked(argv: List<String>): Result<Unit> {
        val s = try {
            session?.takeIf { it.process.isAlive } ?: start()
        } catch (e: Exception) {
            return Result.failure(InputInjectionException("Could not start shell: ${e.message}", e))
        }
        val marker = "__DONE_${++counter}_"
        val line = argv.joinToString(" ") { ShellCommands.shellQuote(it) } + " ; echo \"$marker\$?\"\n"
        try {
            s.writer.write(line)
            s.writer.flush()
        } catch (e: Exception) {
            discard(s)
            return Result.failure(InputInjectionException("Shell write failed: ${e.message}", e))
        }

        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        val output = StringBuilder()
        while (true) {
            val remaining = deadline - System.nanoTime()
            val next = if (remaining <= 0) null else s.lines.poll(remaining, TimeUnit.NANOSECONDS)
            if (next == null) {
                discard(s)
                return Result.failure(InputInjectionException("Shell command timed out after ${timeoutMs}ms"))
            }
            if (next === EOF) {
                discard(s)
                return Result.failure(InputInjectionException("Shell exited"))
            }
            if (next.startsWith(marker)) {
                val code = next.removePrefix(marker).trim().toIntOrNull() ?: -1
                return if (code == 0) Result.success(Unit)
                else Result.failure(InputInjectionException("Shell command failed (exit $code)${output.takeIf { it.isNotEmpty() }?.let { ": ${it.toString().trim()}" } ?: ""}"))
            }
            if (output.length < 512) output.append(next).append('\n')
        }
    }

    fun close() = synchronized(lock) {
        session?.let { discard(it) }
    }

    private fun start(): Session {
        val s = Session(launcher())
        session = s
        launchCount++
        return s
    }

    private fun discard(s: Session) {
        s.kill()
        if (session === s) session = null
    }

    private companion object {
        val EOF = String()
    }
}
