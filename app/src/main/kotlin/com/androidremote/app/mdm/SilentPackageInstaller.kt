package com.androidremote.app.mdm

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.util.Log
import com.androidremote.app.admin.DeviceOwnerManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlin.coroutines.resume

/**
 * Silent package installer for MDM operations.
 *
 * When the app is Device Owner, installations complete without user prompts.
 * Otherwise, falls back to standard install intent (requires user approval).
 *
 * Usage:
 * ```
 * val installer = SilentPackageInstaller(context)
 * val result = installer.installFromUrl("https://example.com/app.apk", "com.example.app")
 * when (result) {
 *     is InstallResult.Success -> Log.i(TAG, "Installed successfully")
 *     is InstallResult.Failure -> Log.e(TAG, "Failed: ${result.message}")
 * }
 * ```
 */
class SilentPackageInstaller(private val context: Context) {

    companion object {
        private const val TAG = "SilentPackageInstaller"
        private const val DOWNLOAD_BUFFER_SIZE = 8192
        private const val INSTALL_BUFFER_SIZE = 65536
    }

    private val deviceOwnerManager = DeviceOwnerManager(context)
    private val packageInstaller = context.packageManager.packageInstaller

    /**
     * Download and install an APK from a URL.
     *
     * @param url HTTP(S) URL to the APK file
     * @param packageName Expected package name (for verification)
     * @return InstallResult indicating success or failure
     */
    suspend fun installFromUrl(url: String, packageName: String): InstallResult {
        return withContext(Dispatchers.IO) {
            try {
                Log.i(TAG, "Downloading APK from: $url")
                val apkFile = downloadApk(url, packageName)

                try {
                    installFromFile(apkFile, packageName)
                } finally {
                    // Clean up downloaded file
                    if (apkFile.exists()) {
                        apkFile.delete()
                        Log.d(TAG, "Cleaned up temp APK: ${apkFile.name}")
                    }
                }
            } catch (e: DownloadException) {
                Log.e(TAG, "Download failed", e)
                InstallResult.Failure(
                    InstallResult.ERROR_DOWNLOAD_FAILED,
                    "Download failed: ${e.message}"
                )
            } catch (e: Exception) {
                Log.e(TAG, "Installation failed", e)
                InstallResult.Failure(
                    InstallResult.ERROR_UNKNOWN,
                    "Installation failed: ${e.message}"
                )
            }
        }
    }

    /**
     * Install an APK from a local file.
     *
     * @param file Local APK file
     * @param packageName Expected package name (for verification)
     * @return InstallResult indicating success or failure
     */
    suspend fun installFromFile(file: File, packageName: String): InstallResult {
        if (!file.exists()) {
            return InstallResult.Failure(
                InstallResult.ERROR_FILE_NOT_FOUND,
                "APK file not found: ${file.absolutePath}"
            )
        }

        return if (deviceOwnerManager.isDeviceOwner()) {
            installSilently(file, packageName)
        } else {
            installWithUserPrompt(file, packageName)
        }
    }

    /**
     * Uninstall a package.
     *
     * @param packageName Package name to uninstall
     * @return InstallResult indicating success or failure
     */
    suspend fun uninstall(packageName: String): InstallResult {
        return withContext(Dispatchers.IO) {
            try {
                // Check if package is installed
                try {
                    context.packageManager.getPackageInfo(packageName, 0)
                } catch (e: Exception) {
                    return@withContext InstallResult.Failure(
                        InstallResult.ERROR_PACKAGE_NOT_FOUND,
                        "Package not installed: $packageName"
                    )
                }

                if (deviceOwnerManager.isDeviceOwner()) {
                    uninstallSilently(packageName)
                } else {
                    uninstallWithUserPrompt(packageName)
                }
            } catch (e: Exception) {
                Log.e(TAG, "Uninstall failed", e)
                InstallResult.Failure(
                    InstallResult.ERROR_UNKNOWN,
                    "Uninstall failed: ${e.message}"
                )
            }
        }
    }

    /**
     * Check if silent installation is available.
     */
    fun canInstallSilently(): Boolean {
        return deviceOwnerManager.isDeviceOwner()
    }

    // ========================================
    // Private Implementation
    // ========================================

    private fun downloadApk(url: String, packageName: String): File {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.connectTimeout = 30_000
        connection.readTimeout = 60_000

        try {
            connection.connect()

            if (connection.responseCode != HttpURLConnection.HTTP_OK) {
                throw DownloadException("HTTP ${connection.responseCode}: ${connection.responseMessage}")
            }

            val contentLength = connection.contentLength
            Log.d(TAG, "APK size: $contentLength bytes")

            // Create temp file in cache directory
            val tempFile = File(context.cacheDir, "download_${packageName}_${System.currentTimeMillis()}.apk")

            connection.inputStream.use { input ->
                FileOutputStream(tempFile).use { output ->
                    val buffer = ByteArray(DOWNLOAD_BUFFER_SIZE)
                    var bytesRead: Int
                    var totalBytesRead = 0L

                    while (input.read(buffer).also { bytesRead = it } != -1) {
                        output.write(buffer, 0, bytesRead)
                        totalBytesRead += bytesRead

                        // Log progress every 1MB
                        if (totalBytesRead % (1024 * 1024) < DOWNLOAD_BUFFER_SIZE) {
                            Log.d(TAG, "Downloaded: ${totalBytesRead / 1024}KB")
                        }
                    }
                }
            }

            Log.i(TAG, "APK downloaded to: ${tempFile.absolutePath}")
            return tempFile

        } finally {
            connection.disconnect()
        }
    }

    private suspend fun installSilently(file: File, packageName: String): InstallResult {
        return suspendCancellableCoroutine { continuation ->
            try {
                Log.i(TAG, "Starting silent installation for: $packageName")

                // Create installation session
                val params = PackageInstaller.SessionParams(
                    PackageInstaller.SessionParams.MODE_FULL_INSTALL
                )
                params.setAppPackageName(packageName)

                val sessionId = packageInstaller.createSession(params)
                val session = packageInstaller.openSession(sessionId)

                // Register callback to receive result
                val callbackId = InstallResultReceiver.registerCallback(packageName) { status, message ->
                    val result = when (status) {
                        PackageInstaller.STATUS_SUCCESS -> InstallResult.Success
                        PackageInstaller.STATUS_FAILURE_ABORTED -> InstallResult.Failure(
                            InstallResult.ERROR_ABORTED,
                            message ?: "Installation aborted"
                        )
                        PackageInstaller.STATUS_FAILURE_BLOCKED -> InstallResult.Failure(
                            InstallResult.ERROR_BLOCKED,
                            message ?: "Installation blocked"
                        )
                        PackageInstaller.STATUS_FAILURE_CONFLICT -> InstallResult.Failure(
                            InstallResult.ERROR_CONFLICT,
                            message ?: "Package conflict"
                        )
                        PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> InstallResult.Failure(
                            InstallResult.ERROR_INCOMPATIBLE,
                            message ?: "Incompatible package"
                        )
                        PackageInstaller.STATUS_FAILURE_INVALID -> InstallResult.Failure(
                            InstallResult.ERROR_INVALID,
                            message ?: "Invalid APK"
                        )
                        PackageInstaller.STATUS_FAILURE_STORAGE -> InstallResult.Failure(
                            InstallResult.ERROR_STORAGE,
                            message ?: "Insufficient storage"
                        )
                        else -> InstallResult.Failure(status, message ?: "Unknown error")
                    }

                    if (continuation.isActive) {
                        continuation.resume(result)
                    }
                }

                // Write APK to session
                session.openWrite("package", 0, file.length()).use { outputStream ->
                    file.inputStream().use { inputStream ->
                        val buffer = ByteArray(INSTALL_BUFFER_SIZE)
                        var bytesRead: Int
                        while (inputStream.read(buffer).also { bytesRead = it } != -1) {
                            outputStream.write(buffer, 0, bytesRead)
                        }
                        session.fsync(outputStream)
                    }
                }

                // Create pending intent for result
                val intent = Intent(context, InstallResultReceiver::class.java).apply {
                    action = InstallResultReceiver.ACTION_INSTALL_RESULT
                    putExtra(InstallResultReceiver.EXTRA_CALLBACK_ID, callbackId)
                    putExtra(InstallResultReceiver.EXTRA_PACKAGE_NAME, packageName)
                }

                val pendingIntent = PendingIntent.getBroadcast(
                    context,
                    sessionId,
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
                )

                // Commit the session
                session.commit(pendingIntent.intentSender)
                Log.i(TAG, "Installation session committed for: $packageName")

                // Handle cancellation
                continuation.invokeOnCancellation {
                    InstallResultReceiver.unregisterCallback(callbackId)
                    try {
                        session.abandon()
                    } catch (e: Exception) {
                        Log.w(TAG, "Failed to abandon session", e)
                    }
                }

            } catch (e: Exception) {
                Log.e(TAG, "Failed to create installation session", e)
                if (continuation.isActive) {
                    continuation.resume(
                        InstallResult.Failure(
                            InstallResult.ERROR_SESSION_FAILED,
                            "Session creation failed: ${e.message}"
                        )
                    )
                }
            }
        }
    }

    private fun installWithUserPrompt(file: File, packageName: String): InstallResult {
        Log.i(TAG, "Falling back to user-prompted installation for: $packageName")

        try {
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(
                    Uri.fromFile(file),
                    "application/vnd.android.package-archive"
                )
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }

            context.startActivity(intent)

            // Note: This returns immediately, actual result is unknown
            return InstallResult.UserPromptShown
        } catch (e: Exception) {
            Log.e(TAG, "Failed to launch install prompt", e)
            return InstallResult.Failure(
                InstallResult.ERROR_INTENT_FAILED,
                "Could not launch installer: ${e.message}"
            )
        }
    }

    private suspend fun uninstallSilently(packageName: String): InstallResult {
        return suspendCancellableCoroutine { continuation ->
            try {
                Log.i(TAG, "Starting silent uninstall for: $packageName")

                // Register callback to receive result
                val callbackId = InstallResultReceiver.registerCallback(packageName) { status, message ->
                    val result = when (status) {
                        PackageInstaller.STATUS_SUCCESS -> InstallResult.Success
                        else -> InstallResult.Failure(status, message ?: "Uninstall failed")
                    }

                    if (continuation.isActive) {
                        continuation.resume(result)
                    }
                }

                // Create pending intent for result
                val intent = Intent(context, InstallResultReceiver::class.java).apply {
                    action = InstallResultReceiver.ACTION_UNINSTALL_RESULT
                    putExtra(InstallResultReceiver.EXTRA_CALLBACK_ID, callbackId)
                    putExtra(InstallResultReceiver.EXTRA_PACKAGE_NAME, packageName)
                }

                val pendingIntent = PendingIntent.getBroadcast(
                    context,
                    packageName.hashCode(),
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
                )

                // Request uninstall
                packageInstaller.uninstall(packageName, pendingIntent.intentSender)
                Log.i(TAG, "Uninstall requested for: $packageName")

                // Handle cancellation
                continuation.invokeOnCancellation {
                    InstallResultReceiver.unregisterCallback(callbackId)
                }

            } catch (e: Exception) {
                Log.e(TAG, "Failed to request uninstall", e)
                if (continuation.isActive) {
                    continuation.resume(
                        InstallResult.Failure(
                            InstallResult.ERROR_UNKNOWN,
                            "Uninstall request failed: ${e.message}"
                        )
                    )
                }
            }
        }
    }

    private fun uninstallWithUserPrompt(packageName: String): InstallResult {
        Log.i(TAG, "Falling back to user-prompted uninstall for: $packageName")

        try {
            val intent = Intent(Intent.ACTION_DELETE).apply {
                data = Uri.parse("package:$packageName")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }

            context.startActivity(intent)

            // Note: This returns immediately, actual result is unknown
            return InstallResult.UserPromptShown
        } catch (e: Exception) {
            Log.e(TAG, "Failed to launch uninstall prompt", e)
            return InstallResult.Failure(
                InstallResult.ERROR_INTENT_FAILED,
                "Could not launch uninstaller: ${e.message}"
            )
        }
    }
}

/**
 * Result of an installation or uninstallation operation.
 */
sealed class InstallResult {
    /** Installation completed successfully */
    object Success : InstallResult()

    /** User was prompted (non-Device Owner mode) - result unknown */
    object UserPromptShown : InstallResult()

    /** Installation failed with error code and message */
    data class Failure(val code: Int, val message: String) : InstallResult()

    companion object {
        // Custom error codes (negative to avoid conflict with PackageInstaller codes)
        const val ERROR_DOWNLOAD_FAILED = -1
        const val ERROR_FILE_NOT_FOUND = -2
        const val ERROR_SESSION_FAILED = -3
        const val ERROR_INTENT_FAILED = -4
        const val ERROR_PACKAGE_NOT_FOUND = -5
        const val ERROR_UNKNOWN = -100

        // PackageInstaller status codes (for reference)
        const val ERROR_ABORTED = PackageInstaller.STATUS_FAILURE_ABORTED
        const val ERROR_BLOCKED = PackageInstaller.STATUS_FAILURE_BLOCKED
        const val ERROR_CONFLICT = PackageInstaller.STATUS_FAILURE_CONFLICT
        const val ERROR_INCOMPATIBLE = PackageInstaller.STATUS_FAILURE_INCOMPATIBLE
        const val ERROR_INVALID = PackageInstaller.STATUS_FAILURE_INVALID
        const val ERROR_STORAGE = PackageInstaller.STATUS_FAILURE_STORAGE
    }
}

/**
 * Exception thrown during APK download.
 */
class DownloadException(message: String) : Exception(message)
