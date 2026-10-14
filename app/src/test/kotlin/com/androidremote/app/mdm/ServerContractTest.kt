package com.androidremote.app.mdm

import com.androidremote.app.api.AppUpdatesResponse
import com.androidremote.app.mdm.telemetry.TelemetryValues
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** T14: what this app sends and reads must match server/src (routes/telemetry.ts, app.ts app-updates). */
class ServerContractTest {
    /** Keys of the zod schema in server/src/routes/telemetry.ts. Unknown keys are dropped there. */
    private val serverTelemetryKeys = setOf(
        "batteryLevel", "batteryCharging", "batteryHealth", "networkType", "networkSsid", "ipAddress",
        "signalStrength", "storageUsedBytes", "storageTotalBytes", "memoryUsedBytes", "memoryTotalBytes",
        "screenOn", "brightness", "latitude", "longitude", "locationAccuracy", "uptimeMs",
        "androidSecurityPatch", "kioskActive", "kioskPackage", "lockTask", "protectedPackages", "collectedAt"
    )

    @Test
    fun `every telemetry field the app sends is known to the server`() {
        val json = Json { encodeDefaults = true }
        val sent = json.parseToJsonElement(json.encodeToString(TelemetryData())).jsonObject.keys
        assertTrue(serverTelemetryKeys.containsAll(sent), "unknown to the server: ${sent - serverTelemetryKeys}")
    }

    @Test
    fun `signal strength is dBm in the server range, an invalid reading is dropped`() {
        assertEquals(-58, TelemetryValues.signalDbm(-58))
        assertEquals(0, TelemetryValues.signalDbm(0))
        assertNull(TelemetryValues.signalDbm(-127)) // WifiInfo.INVALID_RSSI
        assertNull(TelemetryValues.signalDbm(-201))
        assertNull(TelemetryValues.signalDbm(55))   // a 0..100 "level" would make the server reject the whole sample
    }

    @Test
    fun `battery level outside 0 to 100 is dropped`() {
        assertEquals(87, TelemetryValues.batteryPercent(87))
        assertNull(TelemetryValues.batteryPercent(Int.MIN_VALUE)) // BatteryManager on unsupported devices
        assertNull(TelemetryValues.batteryPercent(-1))
        assertNull(TelemetryValues.batteryPercent(101))
    }

    @Test
    fun `app-updates reads the version fields the server sends`() {
        val body = """{"updates":[{"packageName":"a.b","currentVersionCode":3,"currentVersionName":"1.0",
            "latestVersionCode":4,"latestVersionName":"1.1","apkUrl":"/api/uploads/apks/a.apk","sha256":"ab"}]}"""
        val u = Json { ignoreUnknownKeys = true }.decodeFromString<AppUpdatesResponse>(body).updates.single()
        assertEquals(3, u.currentVersionCode)
        assertEquals(4, u.latestVersionCode)
    }

    @Test
    fun `nextReportIn is read as milliseconds from the telemetry and batch answers`() {
        assertEquals(60000L, TelemetryValues.nextReportMs("""{"success":true,"nextReportIn":60000}"""))
        assertEquals(60000L, TelemetryValues.nextReportMs("""{"success":true,"accepted":3,"nextReportIn":60000}"""))
        assertNull(TelemetryValues.nextReportMs("""{"success":true}"""))
        assertNull(TelemetryValues.nextReportMs("not json"))
    }
}
