package com.androidremote.app.testsupport

import android.app.Application
import android.util.Log
import io.mockk.every
import io.mockk.mockkStatic
import io.mockk.unmockkStatic

/**
 * Robolectric application for unit tests. Skips AndroidRemoteApplication.onCreate,
 * which initialises the WebRTC native library that is unavailable on the host JVM.
 */
class TestApplication : Application()

/**
 * android.util.Log is a stub on the JVM and throws "not mocked". Call [install] in
 * @BeforeEach and [uninstall] in @AfterEach for tests that reach production logging.
 */
object LogStub {
    fun install() {
        mockkStatic(Log::class)
        every { Log.d(any(), any<String>()) } returns 0
        every { Log.d(any(), any<String>(), any()) } returns 0
        every { Log.i(any(), any<String>()) } returns 0
        every { Log.i(any(), any<String>(), any()) } returns 0
        every { Log.w(any<String>(), any<String>()) } returns 0
        every { Log.w(any<String>(), any<String>(), any()) } returns 0
        every { Log.w(any<String>(), any<Throwable>()) } returns 0
        every { Log.e(any(), any<String>()) } returns 0
        every { Log.e(any(), any<String>(), any()) } returns 0
        every { Log.v(any(), any<String>()) } returns 0
    }

    fun uninstall() {
        unmockkStatic(Log::class)
    }
}
