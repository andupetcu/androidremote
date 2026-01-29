package com.androidremote.app.service

import android.content.Context
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
 * The screen-server APK is bundled in app assets and auto-deployed
 * to /data/local/tmp/screen-server.apk on first use (requires root).
 */
class ScreenServerManager(private val context: Context) {

    companion object {
        private const val TAG = "ScreenServerManager"
        private const val SCREEN_SERVER_PATH = "/data/local/tmp/screen-server.apk"
        private const val SCREEN_SERVER_CLASS = "com.androidremote.screenserver.Server"
        private const val SOCKET_NAME = "android-remote-video"
        private const val ASSET_NAME = "screen-server.apk"
        private const val VERSION_FILE = "/data/local/tmp/screen-server.version"
    }

    /**
     * Ensure the screen-server APK is deployed and up to date.
     *
     * Extracts the bundled APK from app assets to /data/local/tmp/ via root.
     * Uses a version marker file to avoid redundant copies.
     */
    suspend fun ensureDeployed(): Boolean = withContext(Dispatchers.IO) {
        if (!isRooted()) {
            Log.w(TAG, "Cannot deploy screen server without root access")
            return@withContext isScreenServerDeployed()
        }

        val appVersion = try {
            context.packageManager.getPackageInfo(context.packageName, 0).versionCode.toString()
        } catch (e: Exception) {
            "unknown"
        }

        // Check if already deployed with current version
        if (isScreenServerDeployed() && isVersionCurrent(appVersion)) {
            Log.d(TAG, "Screen server already deployed (version $appVersion)")
            return@withContext true
        }

        Log.i(TAG, "Deploying screen server from assets...")
        try {
            // Extract asset to app's internal cache first (app has write access)
            val cacheFile = File(context.cacheDir, ASSET_NAME)
            context.assets.open(ASSET_NAME).use { input ->
                cacheFile.outputStream().use { output ->
                    input.copyTo(output)
                }
            }
            Log.d(TAG, "Extracted to cache: ${cacheFile.absolutePath} (${cacheFile.length()} bytes)")

            // Copy from cache to /data/local/tmp/ via su
            val copyCmd = "cp ${cacheFile.absolutePath} $SCREEN_SERVER_PATH && chmod 644 $SCREEN_SERVER_PATH"
            val process = Runtime.getRuntime().exec(arrayOf("su", "0", "sh", "-c", copyCmd))
            val stderr = process.errorStream.bufferedReader().readText()
            process.waitFor()

            if (process.exitValue() != 0) {
                Log.e(TAG, "Failed to copy screen server: $stderr")
                cacheFile.delete()
                return@withContext false
            }

            // Write version marker
            val versionCmd = "echo '$appVersion' > $VERSION_FILE"
            Runtime.getRuntime().exec(arrayOf("su", "0", "sh", "-c", versionCmd)).waitFor()

            cacheFile.delete()
            Log.i(TAG, "Screen server deployed successfully (version $appVersion)")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to deploy screen server from assets", e)
            false
        }
    }

    private fun isVersionCurrent(appVersion: String): Boolean {
        return try {
            val process = Runtime.getRuntime().exec(arrayOf("su", "0", "sh", "-c", "cat $VERSION_FILE"))
            val version = process.inputStream.bufferedReader().readText().trim()
            process.waitFor()
            version == appVersion
        } catch (e: Exception) {
            false
        }
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
     * Force-restart the screen server. Kills any existing instance first.
     *
     * This is necessary because the screen server can get stuck in an encode loop
     * when SurfaceControl fails to render (no frames produced). A stuck server
     * can't accept new client connections.
     *
     * @return true if started successfully, false otherwise
     */
    suspend fun restartScreenServer(): Boolean = withContext(Dispatchers.IO) {
        Log.i(TAG, "Force-restarting screen server")
        ensureDeployed()
        stopScreenServer()
        delay(500) // Allow process to fully terminate
        startScreenServer()
    }

    /**
     * Attempt to start the screen-server process using available methods.
     *
     * @return true if started successfully, false otherwise
     */
    suspend fun startScreenServer(): Boolean = withContext(Dispatchers.IO) {
        // Auto-deploy from bundled assets if needed
        if (!isScreenServerDeployed()) {
            if (!ensureDeployed()) {
                Log.w(TAG, "Screen server not deployed and auto-deploy failed")
                return@withContext false
            }
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
     * First tries running as shell UID (2000), which matches how scrcpy operates.
     * SurfaceControl requires specific UID/permissions — shell has ACCESS_SURFACE_FLINGER
     * granted by the framework, whereas root (UID 0) may be blocked by SELinux on some SoCs.
     *
     * Falls back to running as root if shell UID doesn't work.
     *
     * Tries two su syntaxes since Android su implementations vary:
     * - "su <uid> sh -c <cmd>" (Rockchip, some stock ROMs)
     * - "su -c <cmd>" (Magisk, SuperSU)
     */
    private suspend fun startViaRoot(): Boolean = withContext(Dispatchers.IO) {
        val serverCmd = "CLASSPATH=$SCREEN_SERVER_PATH " +
                "app_process / $SCREEN_SERVER_CLASS " +
                "2>/data/local/tmp/screen-server.log &"

        // Try shell UID (2000) first — scrcpy uses shell permissions for SurfaceControl.
        // On some SoCs (e.g. Rockchip), root UID (0) may not get proper SurfaceFlinger access.
        for (uid in intArrayOf(2000, 0)) {
            try {
                Log.d(TAG, "Trying su $uid sh -c syntax")
                val process = Runtime.getRuntime().exec(arrayOf("su", uid.toString(), "sh", "-c", serverCmd))
                val stderr = process.errorStream.bufferedReader().readText()
                process.waitFor()
                if (stderr.isNotBlank()) {
                    Log.w(TAG, "su $uid stderr: $stderr")
                }
                delay(1500)
                if (isScreenServerRunning()) {
                    Log.i(TAG, "Screen server started via su $uid")
                    return@withContext true
                }
            } catch (e: Exception) {
                Log.w(TAG, "su $uid syntax failed: ${e.message}")
            }
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

        Log.e(TAG, "Failed to start screen server via root (all su syntaxes failed)")
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
