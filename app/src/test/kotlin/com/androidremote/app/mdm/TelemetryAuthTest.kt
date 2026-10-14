package com.androidremote.app.mdm

import android.content.Context
import org.robolectric.RuntimeEnvironment
import com.androidremote.app.testsupport.LogStub
import com.androidremote.app.testsupport.TestApplication
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpStatusCode
import com.androidremote.app.api.DeviceHttpClient
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = TestApplication::class, sdk = [34])
class TelemetryAuthTest {
    @Before fun setUp() = LogStub.install()
    @After fun tearDown() = LogStub.uninstall()

    @Test
    fun `telemetry post carries the session token`() = runBlocking {
        val ctx = RuntimeEnvironment.getApplication()
        val seen = mutableListOf<HttpRequestData>()
        val engine = MockEngine { req -> seen += req; respond("{}", HttpStatusCode.OK) }
        val http = DeviceHttpClient.create("https://s", { "tok-9" }, engine)
        val ok = TelemetryCollector(ctx, http).sendTelemetrySuspend("https://s", "dev-1")
        assertTrue(ok)
        assertEquals(1, seen.size)
        assertEquals("tok-9", seen[0].headers["X-Session-Token"])
        assertEquals("/api/devices/dev-1/telemetry", seen[0].url.encodedPath)
    }
}
