package com.androidremote.app.mdm

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import com.androidremote.app.BuildConfig
import com.androidremote.app.api.DeviceHttpClient
import com.androidremote.app.ui.SessionStorage
import android.os.Build
import android.util.Log
import com.androidremote.app.admin.DeviceOwnerManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.coroutines.resume

/**
 * Silent package installer for MDM operations.
 *
 * When the app is Device Owner, installations complete without user prompts.
 * Otherwise installs and uninstalls fail with a clear message (no user-prompt fallback).
 *
 * Usage:
 * ```
 * val installer = SilentPackageInstaller(context)
 * val result = installer.installFromUrl(url, "com.example.app", sha256, serverBaseUrl)
 * when (result) {
 *     is InstallResult.Success -> Log.i(TAG, "Installed successfully")
 *     is InstallResult.Failure -> Log.e(TAG, "Failed: ${result.message}")
 * }
 * ```
 */
class SilentPackageInstaller(private val context: Context) {

    companion object {
        private const val TAG = "SilentPackageInstaller"
        private const val INSTALL_BUFFER_SIZE = 65536
    }

    private val deviceOwnerManager = DeviceOwnerManager(context)
    private val packageInstaller = context.packageManager.packageInstaller

    /**
     * Download, verify and install an APK from a URL (contract C6).
     *
     * @param url HTTP(S) URL to the APK file
     * @param packageName Expected package name
     * @param sha256 Expected hex SHA-256 of the APK. Required unless the build sets ALLOW_UNVERIFIED_APK.
     * @param serverBaseUrl The configured server URL; cleartext http is only allowed to its host.
     */
    suspend fun installFromUrl(url: String, packageName: String, sha256: String?, serverBaseUrl: String): InstallResult {
        return withContext(Dispatchers.IO) {
            var apkFile: File? = null
            try {
                // Fail early, before any download, when we could not install silently anyway.
                if (!deviceOwnerManager.isDeviceOwner()) return@withContext notDeviceOwner()

                val sessionStorage = SessionStorage.create(context)
                val http = DeviceHttpClient.create(serverBaseUrl, { sessionStorage.getSessionToken() })
                val fetched = try {
                    VerifiedApkFetcher(ApkDownloader(http), BuildConfig.ALLOW_UNVERIFIED_APK, context.cacheDir)
                        .fetch(url, packageName, sha256, serverBaseUrl)
                } finally {
                    http.close()
                }
                fetched.failure?.let { return@withContext it }
                apkFile = fetched.file!!
                installFromFile(apkFile, packageName)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.e(TAG, "Installation failed", e)
                InstallResult.Failure(InstallResult.ERROR_UNKNOWN, "Installation failed: ${e.message}")
            } finally {
                apkFile?.takeIf { it.exists() }?.let {
                    it.delete()
                    Log.d(TAG, "Cleaned up temp APK: ${it.name}")
                }
            }
        }
    }

    private fun notDeviceOwner() = InstallResult.Failure(
        InstallResult.ERROR_NOT_DEVICE_OWNER,
        "Silent install requires Device Owner privileges"
    )

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
            notDeviceOwner()
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
                    InstallResult.Failure(
                        InstallResult.ERROR_NOT_DEVICE_OWNER,
                        "Silent uninstall requires Device Owner privileges"
                    )
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

    private suspend fun installSilently(file: File, packageName: String): InstallResult {
        return suspendCancellableCoroutine { continuation ->
            var sessionId = -1
            var callbackId = -1L
            var committed = false
            try {
                Log.i(TAG, "Starting silent installation for: $packageName")

                val params = PackageInstaller.SessionParams(
                    PackageInstaller.SessionParams.MODE_FULL_INSTALL
                )
                params.setAppPackageName(packageName)

                sessionId = packageInstaller.createSession(params)
                val session = packageInstaller.openSession(sessionId)
                val openedSessionId = sessionId

                // Always release the session if we do not finish with a commit
                continuation.invokeOnCancellation {
                    if (callbackId >= 0) InstallResultReceiver.unregisterCallback(callbackId)
                    abandonQuietly(openedSessionId)
                }

                callbackId = InstallResultReceiver.registerCallback(packageName) { status, message ->
                    if (status != PackageInstaller.STATUS_SUCCESS) abandonQuietly(openedSessionId)
                    if (continuation.isActive) {
                        continuation.resume(InstallStatusMapper.toResult(status, message))
                    }
                }

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

                session.commit(pendingIntent.intentSender)
                committed = true
                Log.i(TAG, "Installation session committed for: $packageName")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to create installation session", e)
                if (callbackId >= 0) InstallResultReceiver.unregisterCallback(callbackId)
                if (!committed && sessionId >= 0) abandonQuietly(sessionId)
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

    private fun abandonQuietly(sessionId: Int) {
        try {
            packageInstaller.abandonSession(sessionId)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to abandon session $sessionId: ${e.message}")
        }
    }

    private suspend fun uninstallSilently(packageName: String): InstallResult {
        return suspendCancellableCoroutine { continuation ->
            try {
                Log.i(TAG, "Starting silent uninstall for: $packageName")

                // Register callback to receive result
                val callbackId = InstallResultReceiver.registerCallback(packageName) { status, message ->
                    if (continuation.isActive) {
                        continuation.resume(InstallStatusMapper.toResult(status, message, uninstall = true))
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
}

/**
 * Result of an installation or uninstallation operation.
 */
sealed class InstallResult {
    /** Installation completed successfully */
    object Success : InstallResult()

    /** Installation failed with error code and message */
    data class Failure(val code: Int, val message: String) : InstallResult()

    companion object {
        // Custom error codes (negative to avoid conflict with PackageInstaller codes)
        const val ERROR_DOWNLOAD_FAILED = -1
        const val ERROR_FILE_NOT_FOUND = -2
        const val ERROR_SESSION_FAILED = -3
        const val ERROR_INTENT_FAILED = -4
        const val ERROR_PACKAGE_NOT_FOUND = -5
        const val ERROR_HASH_MISMATCH = -6
        const val ERROR_MISSING_HASH = -7
        const val ERROR_URL_REFUSED = -8
        const val ERROR_USER_ACTION_REQUIRED = -9
        const val ERROR_NOT_DEVICE_OWNER = -10
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
class DownloadException(message: String, val fatal: Boolean = false) : Exception(message)
