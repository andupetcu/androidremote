package com.androidremote.app.mdm

import com.androidremote.app.kiosk.KioskConfig
import com.androidremote.app.mdm.telemetry.KioskReport
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class KioskTelemetryTest {
    private val cfg = KioskConfig("com.shop.player", true, true)

    @Test
    fun `no kiosk configured reports inactive and no package`() {
        val r = KioskReport.build(null, foreground = "x.y", protectedPackages = setOf("b.b", "a.a"))
        assertFalse(r.kioskActive); assertEquals(null, r.kioskPackage); assertFalse(r.lockTask)
        assertEquals(listOf("a.a", "b.b"), r.protectedPackages)
    }

    @Test
    fun `configured and target in front is active`() {
        val r = KioskReport.build(cfg, foreground = "com.shop.player", protectedPackages = emptySet())
        assertTrue(r.kioskActive); assertEquals("com.shop.player", r.kioskPackage); assertTrue(r.lockTask)
    }

    @Test
    fun `configured but another app is in front is not active`() {
        assertFalse(KioskReport.build(cfg, foreground = "com.other", protectedPackages = emptySet()).kioskActive)
    }

    @Test
    fun `foreground unknown falls back to configured`() {
        assertTrue(KioskReport.build(cfg, foreground = null, protectedPackages = emptySet()).kioskActive)
    }

    @Test
    fun `telemetry json carries the kiosk fields including a null package`() {
        val json = Json { encodeDefaults = false }
        val on = json.parseToJsonElement(json.encodeToString(
            TelemetryData(kioskActive = true, kioskPackage = "com.shop.player", lockTask = true, protectedPackages = listOf("a.a"))
        )).jsonObject
        assertTrue(on["kioskActive"]!!.jsonPrimitive.boolean)
        assertEquals("com.shop.player", on["kioskPackage"]!!.jsonPrimitive.content)
        assertTrue(on["lockTask"]!!.jsonPrimitive.boolean)
        assertEquals("a.a", on["protectedPackages"]!!.jsonArray[0].jsonPrimitive.content)
        val off = json.parseToJsonElement(json.encodeToString(TelemetryData(kioskActive = false))).jsonObject
        assertEquals(JsonNull, off["kioskPackage"])
    }

    @Test
    fun `hidden app is reported disabled even when its component is enabled`() {
        assertFalse(InventoryRules.enabled(infoEnabled = true, hidden = true))
        assertTrue(InventoryRules.enabled(infoEnabled = true, hidden = false))
        assertFalse(InventoryRules.enabled(infoEnabled = false, hidden = false))
    }

    @Test
    fun `hidden packages stay in the inventory but removed ones do not`() {
        assertTrue(InventoryRules.include(installedFlag = false, hidden = true))
        assertTrue(InventoryRules.include(installedFlag = true, hidden = false))
        assertFalse(InventoryRules.include(installedFlag = false, hidden = false))
    }

    @Test
    fun `inventory refreshes after app-changing commands that succeeded`() {
        for (t in listOf("DISABLE_APP", "ENABLE_APP", "UNINSTALL_APP", "INSTALL_APK")) {
            assertTrue(InventoryRules.refreshAfter(t, true), t)
            assertFalse(InventoryRules.refreshAfter(t, false), t)
        }
        assertFalse(InventoryRules.refreshAfter("LOCK", true))
    }
}
