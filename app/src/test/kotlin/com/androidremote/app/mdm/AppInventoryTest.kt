package com.androidremote.app.mdm

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class AppInventoryTest {
    @Test
    fun `labels with quotes, backslashes and control characters round-trip`() {
        val nasty = "He said \"hi\" \\ C:\\path\nnew\tline \u0001 \u2603"
        val apps = listOf(
            InstalledApp("com.a", nasty, "1.0\\\"x", 42L, isSystemApp = false, enabled = true),
            InstalledApp("com.b", "", "", 9_000_000_000L, isSystemApp = true, enabled = false)
        )
        val parsed = Json.parseToJsonElement(AppInventory.toJson(apps)).jsonObject["apps"]!!.jsonArray
        assertEquals(2, parsed.size)
        val a = parsed[0].jsonObject
        assertEquals(nasty, a["appName"]!!.jsonPrimitive.content)
        assertEquals("1.0\\\"x", a["versionName"]!!.jsonPrimitive.content)
        assertEquals("com.a", a["packageName"]!!.jsonPrimitive.content)
        assertEquals(42L, a["versionCode"]!!.jsonPrimitive.long)
        assertEquals(false, a["isSystemApp"]!!.jsonPrimitive.boolean)
        val b = parsed[1].jsonObject
        assertEquals(9_000_000_000L, b["versionCode"]!!.jsonPrimitive.long)
        assertEquals(false, b["enabled"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun `empty inventory`() {
        assertEquals(0, Json.parseToJsonElement(AppInventory.toJson(emptyList())).jsonObject["apps"]!!.jsonArray.size)
    }
}
