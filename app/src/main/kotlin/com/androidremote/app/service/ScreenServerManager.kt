package com.androidremote.app.service

import android.content.Context
import android.os.Build
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException

/**
 * Manages the screen-server process for headless screen capture.
 *
 * The screen-server uses SurfaceControl to capture the screen without
 * requiring MediaProjection consent. It runs as a separate process with
 * elevated privileges (shell or root).
 *
 * Approaches to start the screen server:
 * 1. Root access: Start via "su" command
 * 2. ADB: Start via "adb shell" (requires USB or WiFi ADB enabled)
 * 3. Device Owner: Some manufacturers allow shell access
 *
 * The screen-server APK must be deployed to /data/local/tmp/screen-server.apk
 */
class ScreenServerManager(private val context: Context) {

    companion object {
        private const val TAG = "ScreenServerManager"
        private const val SCREEN_SERVER_PATH = "/data/local/tmp/screen-server.apk"
        private const val SCREEN_SERVER_CLASS = "com.androidremote.screenserver.Server"
        private const val SOCKET_NAME = "android-remote-video"
    }

    /**
     * Check if the screen-server APK is deployed.
     */
    fun isScreenServerDeployed(): Boolean {
        return try {
            val process = Runtime.getRuntime().exec(arrayOf("ls", SCREEN_SERVER_PATH))
            process.waitFor()
            process.exitValue() == 0
        } catch (e: Exception) {
            Log.w(TAG, "Failed to check screen-server: ${e.message}")
            false
        }
    }

    /**
     * Check if the device is rooted (su binary available).
     */
    fun isRooted(): Boolean {
        val paths = arrayOf(
            "/system/bin/su",
            "/system/xbin/su",
            "/sbin/su",
            "/data/local/xbin/su",
            "/data/local/bin/su",
            "/data/local/su",
            "/su/bin/su"
        )
        return paths.any { File(it).exists() }
    }

    /**
     * Check if screen-server process is running.
     *
     * Tries multiple methods since Android restricts /proc visibility
     * for app processes (can't see root-owned processes via pgrep).
     */
    suspend fun isScreenServerRunning(): Boolean = withContext(Dispatchers.IO) {
        // Method 1: Check abstract socket existence via /proc/net/unix
        // The screen server binds to @android-remote-video
        try {
            val process = Runtime.getRuntime().exec(arrayOf("sh", "-c", "grep -q $SOCKET_NAME /proc/net/unix"))
            process.waitFor()
            if (process.exitValue() == 0) {
                Log.d(TAG, "Screen server detected via /proc/net/unix socket")
                return@withContext true
            }
        } catch (e: Exception) {
            Log.w(TAG, "Socket check failed: ${e.message}")
        }

        // Method 2: pgrep (works for same-UID processes)
        try {
            val process = Runtime.getRuntime().exec(arrayOf("pgrep", "-f", SCREEN_SERVER_CLASS))
            val result = process.inputStream.bufferedReader().readText()
            process.waitFor()
            if (result.isNotBlank()) {
                Log.d(TAG, "Screen server detected via pgrep")
                return@withContext true
            }
        } catch (e: Exception) {
            Log.w(TAG, "pgrep failed: ${e.message}")
        }

        // Method 3: pgrep via su (can see root-owned processes)
        if (isRooted()) {
            try {
                val process = Runtime.getRuntime().exec(
                    arrayOf("su", "0", "sh", "-c", "pgrep -f $SCREEN_SERVER_CLASS")
                )
                val result = process.inputStream.bufferedReader().readText()
                process.waitFor()
                if (result.isNotBlank()) {
                    Log.d(TAG, "Screen server detected via su pgrep")
                    return@withContext true
                }
            } catch (e: Exception) {
                Log.w(TAG, "su pgrep failed: ${e.message}")
            }
        }

        false
    }

    /**
     * Attempt to start the screen-server process using available methods.
     *
     * @return true if started successfully, false otherwise
     */
    suspend fun startScreenServer(): Boolean = withContext(Dispatchers.IO) {
        if (!isScreenServerDeployed()) {
            Log.w(TAG, "Screen server not deployed to $SCREEN_SERVER_PATH")
            return@withContext false
        }

        // Check if already running
        if (isScreenServerRunning()) {
            Log.d(TAG, "Screen server already running")
            return@withContext true
        }

        // Try root first, then shell
        if (isRooted()) {
            Log.d(TAG, "Attempting to start screen server via root")
            if (startViaRoot()) {
                return@withContext true
            }
        }

        // Try shell (works if adb or shell access available)
        Log.d(TAG, "Attempting to start screen server via shell")
        startViaShell()
    }

    /**
     * Start screen server via root access.
     *
     * Tries two su syntaxes since Android su implementations vary:
     * - "su 0 sh -c <cmd>" (Rockchip, some stock ROMs)
     * - "su -c <cmd>" (Magisk, SuperSU)
     */
    private suspend fun startViaRoot(): Boolean = withContext(Dispatchers.IO) {
        val serverCmd = "CLASSPATH=$SCREEN_SERVER_PATH " +
                "app_process / $SCREEN_SERVER_CLASS " +
                "2>/data/local/tmp/screen-server.log &"

        // Try "su 0 sh -c" first (works on Rockchip and stock ROMs)
        try {
            Log.d(TAG, "Trying su 0 sh -c syntax")
            val process = Runtime.getRuntime().exec(arrayOf("su", "0", "sh", "-c", serverCmd))
            val stderr = process.errorStream.bufferedReader().readText()
            process.waitFor()
            if (stderr.isNotBlank()) {
                Log.w(TAG, "su 0 stderr: $stderr")
            }
            delay(1500)
            if (isScreenServerRunning()) {
                Log.i(TAG, "Screen server started via su 0")
                return@withContext true
            }
        } catch (e: Exception) {
            Log.w(TAG, "su 0 syntax failed: ${e.message}")
        }

        // Fallback to "su -c" (Magisk, SuperSU)
        try {
            Log.d(TAG, "Trying su -c syntax")
            val process = Runtime.getRuntime().exec(arrayOf("su", "-c", serverCmd))
            val stderr = process.errorStream.bufferedReader().readText()
            process.waitFor()
            if (stderr.isNotBlank()) {
                Log.w(TAG, "su -c stderr: $stderr")
            }
            delay(1500)
            if (isScreenServerRunning()) {
                Log.i(TAG, "Screen server started via su -c")
                return@withContext true
            }
        } catch (e: Exception) {
            Log.w(TAG, "su -c syntax failed: ${e.message}")
        }

        Log.e(TAG, "Failed to start screen server via root (both su syntaxes failed)")
        false
    }

    /**
     * Start screen server via shell (may require ADB or special permissions).
     */
    private suspend fun startViaShell(): Boolean = withContext(Dispatchers.IO) {
        try {
            val command = "CLASSPATH=$SCREEN_SERVER_PATH app_process / $SCREEN_SERVER_CLASS &"
            val process = Runtime.getRuntime().exec(arrayOf("sh", "-c", command))

            // Wait a bit for the process to start
            delay(1000)

            // Check if it's running
            isScreenServerRunning()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start screen server via shell", e)
            false
        }
    }

    /**
     * Stop the screen server process.
     */
    suspend fun stopScreenServer(): Boolean = withContext(Dispatchers.IO) {
        try {
            val command = "pkill -f $SCREEN_SERVER_CLASS"
            val process = if (isRooted()) {
                Runtime.getRuntime().exec(arrayOf("su", "0", "sh", "-c", command))
            } else {
                Runtime.getRuntime().exec(arrayOf("sh", "-c", command))
            }
            process.waitFor()
            Log.i(TAG, "Screen server stopped")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to stop screen server", e)
            false
        }
    }

    /**
     * Get instructions for manual screen server setup.
     */
    fun getSetupInstructions(): String {
        return """
            To enable headless screen capture:

            1. Connect device via USB with ADB enabled
            2. Push screen-server: adb push screen-server.apk /data/local/tmp/
            3. Start screen-server: adb shell CLASSPATH=/data/local/tmp/screen-server.apk app_process / com.androidremote.screenserver.Server

            The screen server will run in background and enable consent-free screen capture.
        """.trimIndent()
    }
}
