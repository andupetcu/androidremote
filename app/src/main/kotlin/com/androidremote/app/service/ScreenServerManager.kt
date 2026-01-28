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
     */
    suspend fun isScreenServerRunning(): Boolean = withContext(Dispatchers.IO) {
        try {
            val process = Runtime.getRuntime().exec(arrayOf("pgrep", "-f", SCREEN_SERVER_CLASS))
            val result = process.inputStream.bufferedReader().readText()
            process.waitFor()
            result.isNotBlank()
        } catch (e: Exception) {
            Log.w(TAG, "Failed to check if screen-server is running: ${e.message}")
            false
        }
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
     */
    private suspend fun startViaRoot(): Boolean = withContext(Dispatchers.IO) {
        try {
            val command = "CLASSPATH=$SCREEN_SERVER_PATH app_process / $SCREEN_SERVER_CLASS &"
            val process = Runtime.getRuntime().exec(arrayOf("su", "-c", command))

            // Wait a bit for the process to start
            delay(1000)

            // Check if it's running
            isScreenServerRunning()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start screen server via root", e)
            false
        }
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
                Runtime.getRuntime().exec(arrayOf("su", "-c", command))
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
