package com.androidremote.app.mdm

import android.content.pm.PackageInstaller
import android.util.Log
import io.ktor.client.HttpClient
import io.ktor.client.plugins.timeout
import io.ktor.client.request.header
import io.ktor.client.request.prepareGet
import io.ktor.client.statement.bodyAsChannel
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.utils.io.ByteReadChannel
import io.ktor.utils.io.readAvailable
import kotlinx.coroutines.CancellationException
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.URI
import java.security.MessageDigest

/** Which URLs the device is willing to download an APK from (finding AM-05). */
object InstallUrlPolicy {
    /**
     * @return null when the URL is acceptable, otherwise the reason it is refused.
     * Only http and https are allowed. Cleartext http is allowed only to the configured server host.
     */
    fun check(url: String, serverBaseUrl: String): String? {
        val uri = try { URI(url) } catch (e: Exception) { return "Invalid URL" }
        val scheme = uri.scheme?.lowercase() ?: return "Invalid URL"
        val host = uri.host ?: return "Invalid URL (no host)"
        return when (scheme) {
            "https" -> null
            "http" -> {
                val serverHost = runCatching { URI(serverBaseUrl).host }.getOrNull()
                if (serverHost != null && host.equals(serverHost, ignoreCase = true)) null
                else "Refusing cleartext http download from $host (not the server host)"
            }
            else -> "Unsupported URL scheme: $scheme"
        }
    }
}

object ApkVerifier {
    fun sha256Hex(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                digest.update(buffer, 0, n)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    fun matches(file: File, expected: String): Boolean =
        sha256Hex(file).equals(expected.trim(), ignoreCase = true)
}

/**
 * Resumable APK download over Ktor. If the connection drops, the next attempt sends
 * `Range: bytes=<have>-` and appends. The final size must equal the announced length.
 */
class ApkDownloader(
    private val client: HttpClient,
    private val maxAttempts: Int = 3,
    private val socketTimeoutMs: Long = 60_000
) {
    companion object {
        private const val TAG = "ApkDownloader"
        private const val SAFETY_MARGIN = 16L * 1024 * 1024
    }

    suspend fun download(url: String, dest: File): File {
        var lastError: Exception? = null
        for (attempt in 1..maxAttempts) {
            try {
                if (attemptOnce(url, dest)) return dest
                lastError = DownloadException("Incomplete download")
            } catch (e: DownloadException) {
                if (e.fatal) { dest.delete(); throw e }
                lastError = e
            } catch (e: CancellationException) {
                throw e
            } catch (e: IOException) {
                lastError = e
            } catch (e: Exception) {
                lastError = e
            }
            Log.w(TAG, "Download attempt $attempt/$maxAttempts failed: ${lastError?.message}")
        }
        dest.delete()
        throw DownloadException("Download failed after $maxAttempts attempts: ${lastError?.message}")
    }

    /** @return true when the file is complete. */
    private suspend fun attemptOnce(url: String, dest: File): Boolean {
        val have = if (dest.exists()) dest.length() else 0L
        var complete = false
        client.prepareGet(url) {
            if (have > 0) header(HttpHeaders.Range, "bytes=$have-")
            timeout {
                requestTimeoutMillis = 30 * 60_000L
                socketTimeoutMillis = socketTimeoutMs
            }
        }.execute { response ->
            val status = response.status
            val resuming = status == HttpStatusCode.PartialContent && have > 0
            if (status == HttpStatusCode.RequestedRangeNotSatisfiable) {
                dest.delete()
                throw DownloadException("Server rejected range, restarting")
            }
            if (status != HttpStatusCode.OK && !resuming) {
                throw DownloadException("HTTP ${status.value}: ${status.description}", fatal = true)
            }

            val bodyLength = response.headers[HttpHeaders.ContentLength]?.toLongOrNull()
            val total = when {
                resuming -> response.headers[HttpHeaders.ContentRange]?.substringAfter('/')?.toLongOrNull()
                    ?: bodyLength?.let { it + have }
                else -> bodyLength
            }
            if (total != null) {
                val free = (dest.parentFile ?: dest.absoluteFile.parentFile).usableSpace
                // The APK is stored twice at the peak (download plus install session).
                if (free < (total - if (resuming) have else 0) + total + SAFETY_MARGIN) {
                    throw DownloadException("Insufficient storage for a ${total / 1024} KB APK", fatal = true)
                }
            }

            val channel: ByteReadChannel = response.bodyAsChannel()
            FileOutputStream(dest, resuming).use { out ->
                val buffer = ByteArray(16 * 1024)
                while (true) {
                    val n = channel.readAvailable(buffer)
                    if (n < 0) break
                    if (n > 0) out.write(buffer, 0, n)
                }
                out.fd.sync()
            }
            complete = total == null || dest.length() == total
            if (total != null && dest.length() > total) {
                dest.delete()
                throw DownloadException("Downloaded more bytes than announced")
            }
        }
        return complete
    }
}

/**
 * Applies contract C6 before anything is handed to the package installer: URL policy,
 * a required SHA-256 (unless the build allows unverified APKs), download, and hash comparison.
 */
class VerifiedApkFetcher(
    private val downloader: ApkDownloader,
    private val allowUnverified: Boolean,
    private val cacheDir: File
) {
    data class FetchResult(val file: File?, val failure: InstallResult.Failure?)

    suspend fun fetch(url: String, packageName: String, sha256: String?, serverBaseUrl: String): FetchResult {
        InstallUrlPolicy.check(url, serverBaseUrl)?.let {
            return fail(InstallResult.ERROR_URL_REFUSED, it)
        }
        val expected = sha256?.trim()?.takeIf { it.isNotEmpty() }
        if (expected == null && !allowUnverified) {
            return fail(InstallResult.ERROR_MISSING_HASH, "Refusing install: missing sha256 in command payload")
        }

        val safeName = packageName.replace(Regex("[^A-Za-z0-9._]"), "_")
        val dest = File(cacheDir, "download_${safeName}_${System.currentTimeMillis()}.apk")
        try {
            downloader.download(url, dest)
        } catch (e: DownloadException) {
            dest.delete()
            return fail(InstallResult.ERROR_DOWNLOAD_FAILED, "Download failed: ${e.message}")
        } catch (e: CancellationException) {
            dest.delete()
            throw e
        } catch (e: Exception) {
            dest.delete()
            return fail(InstallResult.ERROR_DOWNLOAD_FAILED, "Download failed: ${e.message}")
        }

        if (expected != null && !ApkVerifier.matches(dest, expected)) {
            dest.delete()
            return fail(InstallResult.ERROR_HASH_MISMATCH, "SHA-256 mismatch: downloaded APK does not match the expected hash")
        }
        return FetchResult(dest, null)
    }

    private fun fail(code: Int, message: String): FetchResult {
        Log.w("VerifiedApkFetcher", message)
        return FetchResult(null, InstallResult.Failure(code, message))
    }
}

/** Maps PackageInstaller status codes to [InstallResult]. */
object InstallStatusMapper {
    fun toResult(status: Int, message: String?, uninstall: Boolean = false): InstallResult = when (status) {
        PackageInstaller.STATUS_SUCCESS -> InstallResult.Success
        PackageInstaller.STATUS_PENDING_USER_ACTION -> InstallResult.Failure(
            InstallResult.ERROR_USER_ACTION_REQUIRED,
            "Android requires user confirmation for this ${if (uninstall) "uninstall" else "install"}; it cannot complete silently" +
                (message?.let { " ($it)" } ?: "")
        )
        PackageInstaller.STATUS_FAILURE_ABORTED -> InstallResult.Failure(InstallResult.ERROR_ABORTED, message ?: "Installation aborted")
        PackageInstaller.STATUS_FAILURE_BLOCKED -> InstallResult.Failure(InstallResult.ERROR_BLOCKED, message ?: "Installation blocked")
        PackageInstaller.STATUS_FAILURE_CONFLICT -> InstallResult.Failure(InstallResult.ERROR_CONFLICT, message ?: "Package conflict")
        PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> InstallResult.Failure(InstallResult.ERROR_INCOMPATIBLE, message ?: "Incompatible package")
        PackageInstaller.STATUS_FAILURE_INVALID -> InstallResult.Failure(InstallResult.ERROR_INVALID, message ?: "Invalid APK")
        PackageInstaller.STATUS_FAILURE_STORAGE -> InstallResult.Failure(InstallResult.ERROR_STORAGE, message ?: "Insufficient storage")
        else -> InstallResult.Failure(status, message ?: if (uninstall) "Uninstall failed" else "Unknown error")
    }
}
