package com.androidremote.feature.input

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.BufferedReader
import java.io.InputStreamReader

/**
 * Input injector that uses ADB shell commands.
 *
 * This implementation runs shell commands via Runtime.exec():
 * - `input tap x y`
 * - `input swipe x1 y1 x2 y2 duration`
 * - `input keyevent code`
 * - `input text "string"`
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
class AdbShellInjector : InputInjector {

    companion object {
        private const val TAG = "AdbShellInjector"
        private const val COMMAND_TIMEOUT_MS = 5000L
    }

    // Cache availability check
    private var availabilityChecked = false
    private var available = false
    private var useRoot = false

    override suspend fun tap(x: Int, y: Int): Result<Unit> {
        return runShellCommand("input tap $x $y")
    }

    override suspend fun swipe(
        startX: Int,
        startY: Int,
        endX: Int,
        endY: Int,
        durationMs: Long
    ): Result<Unit> {
        return runShellCommand("input swipe $startX $startY $endX $endY $durationMs")
    }

    override suspend fun longPress(x: Int, y: Int, durationMs: Long): Result<Unit> {
        // Long press is implemented as a swipe with no movement
        return runShellCommand("input swipe $x $y $x $y $durationMs")
    }

    override suspend fun keyEvent(keyCode: Int): Result<Unit> {
        return runShellCommand("input keyevent $keyCode")
    }

    override suspend fun text(text: String): Result<Unit> {
        // Escape special characters for shell
        val escaped = escapeForShell(text)
        return runShellCommand("input text $escaped")
    }

    override fun isAvailable(): Boolean {
        if (availabilityChecked) {
            return available
        }

        // First check if root is available (needed to inject into other apps)
        // Try both su syntaxes: "su 0 cmd" (Android/Toybox) and "su -c cmd" (Magisk/SuperSU)
        useRoot = try {
            val process = Runtime.getRuntime().exec(arrayOf("su", "0", "id"))
            val exitCode = process.waitFor()
            if (exitCode == 0) {
                true
            } else {
                val process2 = Runtime.getRuntime().exec(arrayOf("su", "-c", "id"))
                process2.waitFor() == 0
            }
        } catch (e: Exception) {
            false
        }
        Log.d(TAG, "Root available: $useRoot")

        // Check if shell input command exists
        available = try {
            val cmd = if (useRoot) arrayOf("su", "0", "sh", "-c", "input") else arrayOf("sh", "-c", "input")
            val process = Runtime.getRuntime().exec(cmd)
            val exitCode = process.waitFor()
            // `input` with no args returns 1, but that means it's available
            exitCode == 0 || exitCode == 1
        } catch (e: Exception) {
            Log.w(TAG, "Shell input not available", e)
            false
        }

        availabilityChecked = true
        Log.d(TAG, "Shell input available: $available (root: $useRoot)")
        return available
    }

    override fun getName(): String = "ADB Shell"

    /**
     * Run a shell command and return the result.
     */
    private suspend fun runShellCommand(command: String): Result<Unit> = withContext(Dispatchers.IO) {
        try {
            Log.d(TAG, "Running: $command")
            val startTime = System.currentTimeMillis()

            val cmd = if (useRoot) arrayOf("su", "0", "sh", "-c", command) else arrayOf("sh", "-c", command)
            val process = Runtime.getRuntime().exec(cmd)
            val exitCode = process.waitFor()

            val elapsed = System.currentTimeMillis() - startTime
            Log.d(TAG, "Command completed in ${elapsed}ms with exit code $exitCode")

            if (exitCode == 0) {
                Result.success(Unit)
            } else {
                // Read stderr for error message
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

    /**
     * Escape a string for safe shell usage.
     *
     * The `input text` command requires special handling:
     * - Spaces become %s
     * - Special characters need escaping
     */
    private fun escapeForShell(text: String): String {
        return buildString {
            for (char in text) {
                when (char) {
                    ' ' -> append("%s")
                    '\'' -> append("\\'")
                    '"' -> append("\\\"")
                    '\\' -> append("\\\\")
                    '`' -> append("\\`")
                    '$' -> append("\\$")
                    '&' -> append("\\&")
                    '|' -> append("\\|")
                    ';' -> append("\\;")
                    '<' -> append("\\<")
                    '>' -> append("\\>")
                    '(' -> append("\\(")
                    ')' -> append("\\)")
                    '[' -> append("\\[")
                    ']' -> append("\\]")
                    '{' -> append("\\{")
                    '}' -> append("\\}")
                    else -> append(char)
                }
            }
        }
    }
}
