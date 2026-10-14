package com.androidremote.app.mdm

import android.content.pm.PackageInstaller
import com.androidremote.app.api.DeviceHttpClient
import com.androidremote.app.testsupport.LogStub
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.security.MessageDigest

class ApkInstallTest {
    @TempDir lateinit var dir: File

    @BeforeEach fun setUp() = LogStub.install()
    @AfterEach fun tearDown() = LogStub.uninstall()

    private val base = "https://mdm.example.com"
    private val apk = ByteArray(5000) { (it % 251).toByte() }
    private val apkSha = MessageDigest.getInstance("SHA-256").digest(apk).joinToString("") { "%02x".format(it) }
    private val requests = mutableListOf<String>()

    private fun fetcher(allowUnverified: Boolean = false, handler: (String) -> ByteArray = { apk }): VerifiedApkFetcher {
        val engine = MockEngine { req ->
            requests += req.url.toString()
            respond(handler(req.url.toString()), HttpStatusCode.OK, headersOf(HttpHeaders.ContentLength, apk.size.toString()))
        }
        val http = DeviceHttpClient.create(base, { "t" }, engine)
        return VerifiedApkFetcher(ApkDownloader(http), allowUnverified, dir)
    }

    @Test
    fun `matching sha256 returns the file`() = runTest {
        val r = fetcher().fetch("$base/dl/a.apk", "com.x.y", apkSha, base)
        assertNull(r.failure)
        assertTrue(r.file!!.readBytes().contentEquals(apk))
    }

    @Test
    fun `sha256 comparison ignores case and whitespace`() = runTest {
        val r = fetcher().fetch("$base/dl/a.apk", "com.x.y", " ${apkSha.uppercase()} ", base)
        assertNull(r.failure)
    }

    @Test
    fun `sha256 mismatch refuses the install and deletes the file`() = runTest {
        val r = fetcher().fetch("$base/dl/a.apk", "com.x.y", "00".repeat(32), base)
        assertEquals(InstallResult.ERROR_HASH_MISMATCH, r.failure!!.code)
        assertNull(r.file)
        assertEquals(0, dir.listFiles()!!.size, "tampered download must be removed")
    }

    @Test
    fun `missing sha256 is refused without any download`() = runTest {
        val r = fetcher().fetch("$base/dl/a.apk", "com.x.y", null, base)
        assertEquals(InstallResult.ERROR_MISSING_HASH, r.failure!!.code)
        assertTrue(r.failure!!.message.contains("missing sha256"))
        assertTrue(requests.isEmpty())
        val blank = fetcher().fetch("$base/dl/a.apk", "com.x.y", "  ", base)
        assertEquals(InstallResult.ERROR_MISSING_HASH, blank.failure!!.code)
    }

    @Test
    fun `missing sha256 is allowed only with the unverified flag`() = runTest {
        val r = fetcher(allowUnverified = true).fetch("$base/dl/a.apk", "com.x.y", null, base)
        assertNull(r.failure)
        assertNotNull(r.file)
    }

    @Test
    fun `a mismatching hash is still refused with the unverified flag`() = runTest {
        val r = fetcher(allowUnverified = true).fetch("$base/dl/a.apk", "com.x.y", "ab".repeat(32), base)
        assertEquals(InstallResult.ERROR_HASH_MISMATCH, r.failure!!.code)
    }

    @Test
    fun `cleartext url to a foreign host is refused`() = runTest {
        val r = fetcher().fetch("http://evil.example.net/a.apk", "com.x.y", apkSha, base)
        assertEquals(InstallResult.ERROR_URL_REFUSED, r.failure!!.code)
        assertTrue(requests.isEmpty())
    }

    @Test
    fun `url policy`() {
        assertNull(InstallUrlPolicy.check("https://mdm.example.com/a.apk", base))
        assertNull(InstallUrlPolicy.check("https://cdn.other.net/a.apk", base))
        assertNull(InstallUrlPolicy.check("http://mdm.example.com/a.apk", "http://mdm.example.com"))
        assertNull(InstallUrlPolicy.check("http://192.168.1.5:3000/a.apk", "http://192.168.1.5:3000"))
        assertNotNull(InstallUrlPolicy.check("http://cdn.other.net/a.apk", base))
        assertNotNull(InstallUrlPolicy.check("HTTP://cdn.other.net/a.apk", base))
        assertNotNull(InstallUrlPolicy.check("file:///sdcard/a.apk", base))
        assertNotNull(InstallUrlPolicy.check("ftp://mdm.example.com/a.apk", base))
        assertNotNull(InstallUrlPolicy.check("not a url", base))
        assertNotNull(InstallUrlPolicy.check("http://mdm.example.com@evil.net/a.apk", "http://mdm.example.com"))
    }

    @Test
    fun `download resumes with a Range request after a dropped connection`() = runTest {
        var call = 0
        val ranges = mutableListOf<String?>()
        val engine = MockEngine { req ->
            ranges += req.headers[HttpHeaders.Range]
            call++
            if (call == 1) {
                // server announces full length but the stream is cut after 2000 bytes
                respond(
                    apk.copyOfRange(0, 2000), HttpStatusCode.OK,
                    headersOf(HttpHeaders.ContentLength, apk.size.toString())
                )
            } else {
                respond(
                    apk.copyOfRange(2000, apk.size), HttpStatusCode.PartialContent,
                    headersOf(
                        HttpHeaders.ContentLength to listOf((apk.size - 2000).toString()),
                        HttpHeaders.ContentRange to listOf("bytes 2000-${apk.size - 1}/${apk.size}")
                    )
                )
            }
        }
        val http = DeviceHttpClient.create(base, { "t" }, engine)
        val out = File(dir, "x.apk")
        ApkDownloader(http).download("$base/dl/a.apk", out)
        assertEquals(listOf<String?>(null, "bytes=2000-"), ranges)
        assertTrue(out.readBytes().contentEquals(apk))
    }

    @Test
    fun `download fails with a length error when the server keeps truncating`() = runTest {
        val engine = MockEngine {
            respond(apk.copyOfRange(0, 100), HttpStatusCode.OK, headersOf(HttpHeaders.ContentLength, apk.size.toString()))
        }
        val http = DeviceHttpClient.create(base, { "t" }, engine)
        val e = runCatching { ApkDownloader(http, maxAttempts = 2).download("$base/a.apk", File(dir, "y.apk")) }.exceptionOrNull()
        assertTrue(e is DownloadException, "expected DownloadException, was $e")
    }

    @Test
    fun `http error status fails the download`() = runTest {
        val engine = MockEngine { respond("no", HttpStatusCode.NotFound) }
        val http = DeviceHttpClient.create(base, { "t" }, engine)
        val e = runCatching { ApkDownloader(http).download("$base/a.apk", File(dir, "z.apk")) }.exceptionOrNull()
        assertTrue(e is DownloadException)
        assertFalse(File(dir, "z.apk").exists())
    }

    @Test
    fun `pending user action is a clear failure not a hang`() {
        val r = InstallStatusMapper.toResult(PackageInstaller.STATUS_PENDING_USER_ACTION, null) as InstallResult.Failure
        assertEquals(InstallResult.ERROR_USER_ACTION_REQUIRED, r.code)
        assertTrue(r.message.contains("confirmation"))
        assertEquals(InstallResult.Success, InstallStatusMapper.toResult(PackageInstaller.STATUS_SUCCESS, null))
        val b = InstallStatusMapper.toResult(PackageInstaller.STATUS_FAILURE_BLOCKED, null) as InstallResult.Failure
        assertEquals(InstallResult.ERROR_BLOCKED, b.code)
    }
}
