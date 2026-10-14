package com.androidremote.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import com.androidremote.app.testsupport.TestApplication

/**
 * Uses the public [SessionStorage.create] factory under Robolectric, so the real
 * SharedPreferences (and the encrypted-prefs fallback path) are exercised.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], application = TestApplication::class)
class SessionStorageTest {

    private lateinit var storage: SessionStorage

    @Before
    fun setup() {
        storage = SessionStorage.create(RuntimeEnvironment.getApplication())
        storage.clear()
    }

    @Test
    fun `saves session token`() {
        storage.saveSessionToken("test-token")

        assertEquals("test-token", storage.getSessionToken())
    }

    @Test
    fun `retrieves session token`() {
        storage.saveSessionToken("saved-token")

        assertEquals("saved-token", storage.getSessionToken())
    }

    @Test
    fun `returns null when no session token saved`() {
        assertNull(storage.getSessionToken())
    }

    @Test
    fun `clears session data`() {
        storage.saveSessionToken("token")
        storage.saveDeviceId("device-123")
        storage.saveServerUrl("ws://example.com")

        storage.clear()

        assertNull(storage.getSessionToken())
        assertNull(storage.getDeviceId())
        assertNull(storage.getServerUrl())
    }

    @Test
    fun `saves and retrieves server url`() {
        storage.saveServerUrl("ws://example.com")

        assertEquals("ws://example.com", storage.getServerUrl())
    }

    @Test
    fun `saves and retrieves device id`() {
        storage.saveDeviceId("device-123")

        assertEquals("device-123", storage.getDeviceId())
    }
}
