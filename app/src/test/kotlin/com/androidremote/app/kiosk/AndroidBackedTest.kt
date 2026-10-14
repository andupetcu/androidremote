package com.androidremote.app.kiosk

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.provider.Settings
import com.androidremote.app.admin.DeviceOwnerManager
import com.androidremote.app.admin.DeviceOwnerReceiver
import com.androidremote.app.testsupport.TestApplication
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

private fun obj(s: String): JsonObject = Json.parseToJsonElement(s).jsonObject

@RunWith(RobolectricTestRunner::class)
@Config(application = TestApplication::class, sdk = [34])
class BootAppsStoreTest {
    private fun prefs() = RuntimeEnvironment.getApplication().getSharedPreferences("boot_apps", Context.MODE_PRIVATE)

    @Test
    fun `saving a new foreground app clears the old one`() {
        val s = BootApps(prefs())
        s.save("com.a.b", true)
        s.save("com.c.d", false)
        s.save("com.e.f", true)
        assertEquals(mapOf("com.c.d" to false, "com.e.f" to true), s.all())
        assertEquals("com.e.f", s.foreground())
    }

    @Test
    fun `entries can be removed`() {
        val s = BootApps(prefs())
        s.save("com.a.b", true)
        s.remove("com.a.b")
        assertTrue(s.all().isEmpty())
        assertNull(s.foreground())
    }

    @Test
    fun `replaceAll drops stale entries in one step`() {
        val s = BootApps(prefs())
        s.save("com.old.one", true)
        s.save("com.old.two", false)
        s.replaceAll(mapOf("com.new.one" to true))
        assertEquals(mapOf("com.new.one" to true), s.all())
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(application = TestApplication::class, sdk = [34])
class AppManagementTest {
    private val ctx get() = RuntimeEnvironment.getApplication()
    private lateinit var dpm: DevicePolicyManager
    private lateinit var mgmt: AppManagement

    @Before
    fun setUp() {
        dpm = ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        shadowOf(dpm).setDeviceOwner(ComponentName(ctx, DeviceOwnerReceiver::class.java))
        mgmt = AppManagement(ctx, DeviceOwnerManager(ctx))
        for (pkg in listOf("com.protected.app", "com.other.app")) {
            shadowOf(ctx.packageManager).installPackage(
                android.content.pm.PackageInfo().apply {
                    packageName = pkg
                    applicationInfo = android.content.pm.ApplicationInfo().apply { packageName = pkg }
                }
            )
        }
    }

    @Test
    fun `disable refuses own package and does not hide it`() {
        val r = mgmt.disableApp(obj("""{"packageName":"${ctx.packageName}"}"""))
        assertFalse(r.success)
        assertFalse(dpm.isApplicationHidden(DeviceOwnerReceiver.getComponentName(ctx), ctx.packageName))
    }

    @Test
    fun `disable refuses a protected package, allows others, enable reverses`() {
        assertTrue(mgmt.setProtectedPackages(obj("""{"packages":["com.protected.app"]}""")).success)
        val admin = DeviceOwnerReceiver.getComponentName(ctx)
        assertFalse(mgmt.disableApp(obj("""{"packageName":"com.protected.app"}""")).success)
        assertFalse(dpm.isApplicationHidden(admin, "com.protected.app"))

        assertTrue(mgmt.disableApp(obj("""{"packageName":"com.other.app"}""")).success)
        assertTrue(dpm.isApplicationHidden(admin, "com.other.app"))
        assertTrue(mgmt.enableApp(obj("""{"packageName":"com.other.app"}""")).success)
        assertFalse(dpm.isApplicationHidden(admin, "com.other.app"))
    }

    @Test
    fun `uninstall guard refuses self and protected packages`() {
        mgmt.setProtectedPackages(obj("""{"packages":["com.protected.app"]}"""))
        assertTrue(mgmt.uninstallRefusal(ctx.packageName) != null)
        assertTrue(mgmt.uninstallRefusal("com.protected.app") != null)
        assertNull(mgmt.uninstallRefusal("com.other.app"))
    }

    @Test
    fun `grant permission sets the requested state`() {
        val r = mgmt.grantPermission(obj("""{"packageName":"com.other.app","permission":"android.permission.CAMERA","state":"granted"}"""))
        assertTrue(r.success)
        assertEquals(
            DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED,
            dpm.getPermissionGrantState(DeviceOwnerReceiver.getComponentName(ctx), "com.other.app", "android.permission.CAMERA")
        )
        assertFalse(mgmt.grantPermission(obj("""{"packageName":"com.other.app","permission":"android.permission.CAMERA","state":"bogus"}""")).success)
        assertFalse(mgmt.grantPermission(obj("""{"packageName":"com.other.app","state":"granted"}""")).success)
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(application = TestApplication::class, sdk = [34])
class SilentModeSettingsTest {
    @Test
    fun `silent mode does not write the notification policy secure setting`() {
        val ctx = RuntimeEnvironment.getApplication()
        val dpm = ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        shadowOf(dpm).setDeviceOwner(ComponentName(ctx, DeviceOwnerReceiver::class.java))
        Settings.Secure.putString(ctx.contentResolver, "enabled_notification_policy_access_packages", "com.existing.dnd")

        DeviceOwnerManager(ctx).enableSilentMode()

        assertEquals(
            "com.existing.dnd",
            Settings.Secure.getString(ctx.contentResolver, "enabled_notification_policy_access_packages")
        )
    }
}
