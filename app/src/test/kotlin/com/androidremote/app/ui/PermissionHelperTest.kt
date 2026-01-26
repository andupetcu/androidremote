package com.androidremote.app.ui

import android.content.Context
import android.provider.Settings
import io.mockk.every
import io.mockk.mockk
import io.mockk.mockkStatic
import io.mockk.unmockkStatic
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class PermissionHelperTest {

    private lateinit var context: Context
    private lateinit var helper: PermissionHelper

    @BeforeEach
    fun setup() {
        context = mockk(relaxed = true)
        helper = PermissionHelper(context)
    }

    @AfterEach
    fun tearDown() {
        unmockkStatic(Settings.Secure::class)
    }

    @Test
    fun `isAccessibilityServiceEnabled returns false when service not in settings`() {
        mockkStatic(Settings.Secure::class)
        every {
            Settings.Secure.getString(any(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
        } returns null

        assertFalse(helper.isAccessibilityServiceEnabled())
    }

    @Test
    fun `isAccessibilityServiceEnabled returns true when service is enabled`() {
        mockkStatic(Settings.Secure::class)
        every {
            Settings.Secure.getString(any(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
        } returns "com.androidremote.app/.service.InputInjectionService"
        every { context.packageName } returns "com.androidremote.app"

        assertTrue(helper.isAccessibilityServiceEnabled())
    }

    @Test
    fun `isAccessibilityServiceEnabled returns true for fully qualified service name`() {
        mockkStatic(Settings.Secure::class)
        every {
            Settings.Secure.getString(any(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
        } returns "com.androidremote.app/com.androidremote.app.service.InputInjectionService"
        every { context.packageName } returns "com.androidremote.app"

        assertTrue(helper.isAccessibilityServiceEnabled())
    }

    @Test
    fun `isAccessibilityServiceEnabled returns false when different service enabled`() {
        mockkStatic(Settings.Secure::class)
        every {
            Settings.Secure.getString(any(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
        } returns "com.other.app/.OtherService"
        every { context.packageName } returns "com.androidremote.app"

        assertFalse(helper.isAccessibilityServiceEnabled())
    }

    @Test
    fun `hasAllRequiredPermissions returns false when accessibility disabled`() {
        mockkStatic(Settings.Secure::class)
        every {
            Settings.Secure.getString(any(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
        } returns null

        assertFalse(helper.hasAllRequiredPermissions())
    }
}
