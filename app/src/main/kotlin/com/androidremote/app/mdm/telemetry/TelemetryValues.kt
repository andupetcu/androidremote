package com.androidremote.app.mdm.telemetry

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * Range checks that keep one bad reading from getting a whole telemetry sample rejected: the server
 * validates `signalStrength` (dBm, -200..0) and `batteryLevel` (0..100) and answers 400 otherwise.
 */
object TelemetryValues {
    private const val INVALID_RSSI = -127 // WifiInfo.INVALID_RSSI

    fun signalDbm(rssi: Int): Int? = if (rssi == INVALID_RSSI || rssi < -200 || rssi > 0) null else rssi

    fun batteryPercent(raw: Int): Int? = if (raw in 0..100) raw else null

    /** `nextReportIn` (milliseconds) from a telemetry or batch response body, or null when absent. */
    fun nextReportMs(body: String): Long? = try {
        (Json.parseToJsonElement(body) as? JsonObject)?.get("nextReportIn")?.jsonPrimitive?.longOrNull
    } catch (e: Exception) {
        null
    }
}
