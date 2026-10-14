package com.androidremote.app.mdm

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class RootedTelemetryTest {
    @Test
    fun `rooted is part of the telemetry payload`() {
        val json = Json { encodeDefaults = false }
        val o = json.parseToJsonElement(json.encodeToString(TelemetryData(rooted = true))).jsonObject
        assertEquals(true, o["rooted"]!!.jsonPrimitive.boolean)
        val o2 = json.parseToJsonElement(json.encodeToString(TelemetryData(rooted = false))).jsonObject
        assertEquals(false, o2["rooted"]!!.jsonPrimitive.boolean)
    }
}
