package com.androidremote.feature.input

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import android.os.Looper
import java.io.BufferedReader
import java.io.InputStreamReader
import java.util.concurrent.TimeUnit

/**
 * Input injector that uses ADB shell commands.
 *
 * This implementation runs shell commands via Runtime.exec():
 * - `input tap x y`
 * - `input swipe x1 y1 x2 y2 duration`
 * - `input keyevent code`
 * - `input text <string>` (always passed as an argv element, never via `sh -c`)
 *
 * ## Requirements
 *
 * This injector works when:
 * - The app runs with shell UID (via `adb shell am start`)
 * - The device is rooted and the app has root access
 * - The app is a system app with appropriate permissions
 *
 * ## Performance
 *
 * Each command spawns a new process, resulting in ~100-200ms latency per action.
 * For real-time control, use [RootDaemonBridge] instead.
 *
 * ## Usage
 *
 * ```kotlin
 * val injector = AdbShellInjector()
 * if (injector.isAvailable()) {
 *     injector.tap(500, 800).onSuccess {
 *         Log.d("Input", "Tap successful")
 *     }.onFailure {
 *         Log.e("Input", "Tap failed", it)
 *     }
 * }
 * ```
 */
class AdbShellInjector internal constructor(private val probe: ShellProbe) : InputInjector {

    constructor() : this(defaultProbe())

    companion object {
        private const val TAG = "AdbShellInjector"
        private const val COMMAND_TIMEOUT_MS = 5000L

        private fun defaultProbe() = ShellProbe(
            exec = { argv -> execForExitCode(argv) },
            isMainThread = {
                try { Looper.getMainLooper() != null && Looper.myLooper() == Looper.getMainLooper() } catch (e: Throwable) { false }
            },
            clock = { System.currentTimeMillis() },
            background = { r -> Thread(r, "shell-probe").apply { isDaemon = true }.start() }
        )

        private fun execForExitCode(argv: List<String>): Int? = try {
            val process = Runtime.getRuntime().exec(argv.toTypedArray())
            if (process.waitFor(COMMAND_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                process.exitValue()
            } else {
                process.destroyForcibly()
                null
            }
        } catch (e: Exception) {
            null
        }
    }

    init {
        // Probe off the calling thread so Main is never blocked.
        probe.warmUp()
    }

    override suspend fun tap(x: Int, y: Int): Result<Unit> =
        run { ShellCommands.tap(x, y, it) }

    override suspend fun swipe(
        startX: Int,
        startY: Int,
        endX: Int,
        endY: Int,
        durationMs: Long
    ): Result<Unit> = run { ShellCommands.swipe(startX, startY, endX, endY, durationMs, it) }

    override suspend fun longPress(x: Int, y: Int, durationMs: Long): Result<Unit> =
        // Long press is implemented as a swipe with no movement
        run { ShellCommands.swipe(x, y, x, y, durationMs, it) }

    override suspend fun keyEvent(keyCode: Int): Result<Unit> =
        run { ShellCommands.keyEvent(keyCode, it) }

    override suspend fun text(text: String): Result<Unit> {
        // Control characters are stripped; the text is a single argv element.
        if (ShellCommands.inputText(text, RootMode.NONE) == null) return Result.success(Unit)
        return run { ShellCommands.inputText(text, it)!! }
    }

    override fun isAvailable(): Boolean = probe.isAvailable()

    override fun getName(): String = "ADB Shell"

    // One long-lived shell per root mode; avoids forking `su` for every tap (AR-06).
    private var persistent: PersistentShell? = null
    private var persistentMode: RootMode? = null

    private fun shellFor(mode: RootMode): PersistentShell = synchronized(this) {
        if (persistentMode != mode) {
            persistent?.close()
            persistent = PersistentShell({
                val argv = when (mode) {
                    RootMode.NONE -> listOf("sh")
                    RootMode.SU_UID -> listOf("su", "0", "sh")
                    RootMode.SU_C -> listOf("su", "-c", "sh")
                }
                ProcessBuilder(argv).redirectErrorStream(true).start()
            }, COMMAND_TIMEOUT_MS)
            persistentMode = mode
        }
        persistent!!
    }

    private suspend fun run(build: (RootMode) -> List<String>): Result<Unit> = withContext(Dispatchers.IO) {
        // We are off Main here, so a due probe runs synchronously.
        if (!probe.isAvailable()) {
            return@withContext Result.failure(InputInjectionException("Shell input not available"))
        }
        val mode = probe.rootMode
        // The persistent shell is already elevated: send the bare `input ...` argv.
        val bare = build(RootMode.NONE)
        shellFor(mode).run(bare).also { r ->
            r.exceptionOrNull()?.let { Log.w(TAG, "Persistent shell: ${it.message}") }
        }
    }

    /** Execute argv directly (no `sh -c`). */
    private fun runCommand(argv: List<String>): Result<Unit> {
        return try {
            Log.d(TAG, "Running: ${ShellCommands.describeForLog(argv)}")
            val startTime = System.currentTimeMillis()

            val process = Runtime.getRuntime().exec(argv.toTypedArray())
            val exitCode = process.waitFor()

            val elapsed = System.currentTimeMillis() - startTime
            Log.d(TAG, "Command completed in ${elapsed}ms with exit code $exitCode")

            if (exitCode == 0) {
                Result.success(Unit)
            } else {
                val stderr = BufferedReader(InputStreamReader(process.errorStream))
                    .readText()
                    .trim()

                val errorMessage = if (stderr.isNotEmpty()) {
                    "Shell command failed (exit $exitCode): $stderr"
                } else {
                    "Shell command failed with exit code $exitCode"
                }

                Log.w(TAG, errorMessage)
                Result.failure(InputInjectionException(errorMessage))
            }
        } catch (e: Exception) {
            Log.e(TAG, "Shell command failed", e)
            Result.failure(InputInjectionException("Shell execution failed: ${e.message}", e))
        }
    }
}
