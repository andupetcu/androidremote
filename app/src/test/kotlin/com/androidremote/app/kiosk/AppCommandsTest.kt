package com.androidremote.app.kiosk

import android.app.admin.DevicePolicyManager
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

private fun obj(s: String): JsonObject = Json.parseToJsonElement(s).jsonObject

class ProtectedPackagesTest {
    private val own = "com.androidremote.app"

    @Test
    fun `own package is always refused`() {
        assertNotNull(ProtectedPackages.refusal(own, own, emptySet(), "UNINSTALL_APP"))
        assertNotNull(ProtectedPackages.refusal(own, own, emptySet(), "DISABLE_APP"))
    }

    @Test
    fun `listed packages are refused, others allowed`() {
        val prot = setOf("com.android.settings", "com.footprints.player")
        assertNotNull(ProtectedPackages.refusal("com.android.settings", own, prot, "DISABLE_APP"))
        assertNull(ProtectedPackages.refusal("com.some.game", own, prot, "DISABLE_APP"))
    }

    @Test
    fun `refusal message names the package and the action`() {
        val msg = ProtectedPackages.refusal("com.x.y", own, setOf("com.x.y"), "UNINSTALL_APP")!!
        assertTrue(msg.contains("com.x.y") && msg.contains("UNINSTALL_APP"))
    }

    @Test
    fun `parse list drops blanks and invalid names`() {
        val r = ProtectedPackages.parse(obj("""{"packages":["com.a.b"," ","bad name","com.c.d"]}"""))
        assertEquals(setOf("com.a.b", "com.c.d"), r)
        assertNull(ProtectedPackages.parse(obj("""{"nope":1}""")))
    }
}

class WipeGuardTest {
    @Test
    fun `wipe needs confirm equal to the device id`() {
        assertNull(WipeGuard.check(obj("""{"confirm":"dev-1"}"""), "dev-1"))
        assertNotNull(WipeGuard.check(obj("""{}"""), "dev-1"))
        assertNotNull(WipeGuard.check(obj("""{"confirm":"dev-2"}"""), "dev-1"))
        assertNotNull(WipeGuard.check(obj("""{"confirm":""}"""), "dev-1"))
        assertNotNull(WipeGuard.check(obj("""{"confirm":"dev-1"}"""), null))
        assertNotNull(WipeGuard.check(obj("""{"confirm":"dev-1"}"""), ""))
    }

    @Test
    fun `external storage is wiped only when explicitly asked`() {
        assertEquals(0, WipeGuard.flags(obj("""{"confirm":"d"}""")))
        assertEquals(DevicePolicyManager.WIPE_EXTERNAL_STORAGE, WipeGuard.flags(obj("""{"confirm":"d","wipeExternalStorage":true}""")))
    }
}

class GrantStateTest {
    @Test
    fun `maps the three C10 states`() {
        assertEquals(DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED, GrantStates.fromName("granted"))
        assertEquals(DevicePolicyManager.PERMISSION_GRANT_STATE_DENIED, GrantStates.fromName("denied"))
        assertEquals(DevicePolicyManager.PERMISSION_GRANT_STATE_DEFAULT, GrantStates.fromName("default"))
        assertNull(GrantStates.fromName("maybe"))
        assertNull(GrantStates.fromName(null))
    }
}

class PolicyUpdateTest {
    @Test
    fun `absent fields stay unchanged (null), present fields are read`() {
        val p = PolicyUpdate.parse(obj("""{}"""))
        assertNull(p.silentMode)
        assertNull(p.kioskMode)
        assertNull(p.requiredApps)
        assertFalse(p.updateWindowProvided)

        val q = PolicyUpdate.parse(obj("""{"silentMode":true}"""))
        assertEquals(true, q.silentMode)
        assertNull(q.kioskMode)

        val r = PolicyUpdate.parse(obj("""{"silentMode":false,"kioskMode":"true"}"""))
        assertEquals(false, r.silentMode)
        assertEquals(true, r.kioskMode)
    }

    @Test
    fun `required apps and update window`() {
        val p = PolicyUpdate.parse(
            obj(
                """{"requiredApps":[{"packageName":"com.a.b","foregroundApp":true},{"packageName":"com.c.d","autoStartOnBoot":"true"},{"foregroundApp":true}],
                   "updateWindow":{"start":"01:00","end":"03:00"}}"""
            )
        )
        assertEquals(
            listOf(RequiredApp("com.a.b", true, false), RequiredApp("com.c.d", false, true)),
            p.requiredApps
        )
        assertTrue(p.updateWindowProvided)
        assertEquals(MaintenanceWindow(60, 180), p.updateWindow)
    }

    @Test
    fun `explicit null update window clears it`() {
        val p = PolicyUpdate.parse(obj("""{"updateWindow":null}"""))
        assertTrue(p.updateWindowProvided)
        assertNull(p.updateWindow)
    }

    @Test
    fun `boot map is rebuilt from required apps, installed only, one foreground`() {
        val apps = listOf(
            RequiredApp("com.a.b", foreground = true, autoStartOnBoot = false),
            RequiredApp("com.c.d", foreground = false, autoStartOnBoot = true),
            RequiredApp("com.gone", foreground = false, autoStartOnBoot = true),
            RequiredApp("com.e.f", foreground = true, autoStartOnBoot = false),
            RequiredApp("com.g.h", foreground = false, autoStartOnBoot = false)
        )
        val map = BootAppsMerge.fromRequired(apps) { it != "com.gone" }
        assertEquals(mapOf("com.c.d" to false, "com.e.f" to true), map)
        assertEquals(1, map.values.count { it })
        assertFalse(map.containsKey("com.gone"))
        assertFalse(map.containsKey("com.g.h"))
    }
}
