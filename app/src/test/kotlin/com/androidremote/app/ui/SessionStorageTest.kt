package com.androidremote.app.ui

import android.content.SharedPreferences
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class SessionStorageTest {

    private lateinit var prefs: SharedPreferences
    private lateinit var editor: SharedPreferences.Editor
    private lateinit var storage: SessionStorage

    @BeforeEach
    fun setup() {
        prefs = mockk(relaxed = true)
        editor = mockk(relaxed = true)
        every { prefs.edit() } returns editor
        every { editor.putString(any(), any()) } returns editor
        every { editor.remove(any()) } returns editor
        storage = SessionStorage(prefs)
    }

    @Test
    fun `saves session token`() {
        storage.saveSessionToken("test-token")

        verify { editor.putString("session_token", "test-token") }
        verify { editor.apply() }
    }

    @Test
    fun `retrieves session token`() {
        every { prefs.getString("session_token", null) } returns "saved-token"

        assertEquals("saved-token", storage.getSessionToken())
    }

    @Test
    fun `returns null when no session token saved`() {
        every { prefs.getString("session_token", null) } returns null

        assertNull(storage.getSessionToken())
    }

    @Test
    fun `clears session data`() {
        storage.clear()

        verify { editor.remove("session_token") }
        verify { editor.remove("device_id") }
        verify { editor.remove("server_url") }
        verify { editor.apply() }
    }

    @Test
    fun `saves and retrieves server url`() {
        every { prefs.getString("server_url", null) } returns "ws://example.com"

        storage.saveServerUrl("ws://example.com")
        verify { editor.putString("server_url", "ws://example.com") }

        assertEquals("ws://example.com", storage.getServerUrl())
    }

    @Test
    fun `saves and retrieves device id`() {
        every { prefs.getString("device_id", null) } returns "device-123"

        storage.saveDeviceId("device-123")
        verify { editor.putString("device_id", "device-123") }

        assertEquals("device-123", storage.getDeviceId())
    }
}
