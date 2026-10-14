package com.androidremote.app.mdm

import android.Manifest
import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import androidx.core.content.ContextCompat
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import com.androidremote.app.api.CommandApiClient
import com.androidremote.app.api.DeviceHttpClient
import com.androidremote.app.ui.SessionStorage
import io.ktor.client.HttpClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import com.androidremote.app.mdm.telemetry.BatchOutcome
import com.androidremote.app.mdm.telemetry.KioskReport
import com.androidremote.app.mdm.telemetry.TelemetryValues
import com.androidremote.app.mdm.telemetry.LocationFix
import com.androidremote.app.mdm.telemetry.LocationPolicy
import com.androidremote.app.mdm.telemetry.ReportSchedule
import com.androidremote.app.mdm.telemetry.SampleRingBuffer
import com.androidremote.app.mdm.telemetry.TelemetryFlusher
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlin.coroutines.resume

/**
 * Collects device telemetry and sends it to the MDM server.
 */
class TelemetryCollector(
    private val context: Context,
    /** Test seam. Production code leaves it null and gets a client that sends X-Session-Token. */
    httpClientOverride: HttpClient? = null
) {

    private val sessionStorage = SessionStorage.create(context)

    companion object {
        private const val TAG = "TelemetryCollector"
    }

    private var clientBaseUrl: String? = null
    private var httpClient: HttpClient? = httpClientOverride
    private val injectedClient = httpClientOverride != null

    @Synchronized
    private fun clientFor(serverUrl: String): HttpClient {
        if (injectedClient) return httpClient!!
        if (httpClient == null || clientBaseUrl != serverUrl) {
            httpClient?.close()
            httpClient = DeviceHttpClient.create(serverUrl, { sessionStorage.getSessionToken() })
            clientBaseUrl = serverUrl
        }
        return httpClient!!
    }

    private val json = Json { ignoreUnknownKeys = true }

    /** Set by the polling service; supplies the kiosk and protected-package state for each sample. */
    @Volatile var kioskStateProvider: (() -> KioskReport?)? = null

    private fun TelemetryData.withKiosk(k: KioskReport?) =
        if (k == null) this else copy(
            kioskActive = k.kioskActive, kioskPackage = k.kioskPackage,
            lockTask = k.lockTask, protectedPackages = k.protectedPackages
        )

    /**
     * Collect all telemetry data.
     * Each metric is collected independently - failures don't stop other metrics.
     */
    fun collectTelemetry(): TelemetryData {
        return TelemetryData(
            // Battery
            batteryLevel = safeCall { TelemetryValues.batteryPercent(getBatteryLevel()) },
            batteryCharging = safeCall { isCharging() },
            batteryHealth = safeCall { getBatteryHealth() },

            // Network
            networkType = safeCall { getNetworkType() },
            networkSsid = safeCall { getWifiSsid() },
            ipAddress = safeCall { getIpAddress() },
            signalStrength = safeCall { getSignalStrength() },

            // Storage
            storageUsedBytes = safeCall { getUsedStorage() },
            storageTotalBytes = safeCall { getTotalStorage() },

            // Memory
            memoryUsedBytes = safeCall { getUsedMemory() },
            memoryTotalBytes = safeCall { getTotalMemory() },

            // Display
            screenOn = safeCall { isScreenOn() },
            brightness = safeCall { getBrightness() },

            // Location (if permitted)
            latitude = safeCall { getLatitude() },
            longitude = safeCall { getLongitude() },
            locationAccuracy = safeCall { getLocationAccuracy() },

            // System
            uptimeMs = safeCall { getUptimeMs() },
            androidSecurityPatch = safeCall { getSecurityPatch() }
        ).withKiosk(safeCall { kioskStateProvider?.invoke() })
    }

    private inline fun <T> safeCall(block: () -> T?): T? {
        return try {
            block()
        } catch (e: Exception) {
            Log.w(TAG, "Failed to collect metric: ${e.message}")
            null
        }
    }

    /**
     * Send telemetry to the server (blocking wrapper for callers that are not coroutines).
     */
    fun sendTelemetry(serverUrl: String, deviceId: String): Boolean =
        runBlocking { sendTelemetrySuspend(serverUrl, deviceId) }

    /** Offline buffer of up to 1000 samples (AM-18). */
    private val buffer = SampleRingBuffer(java.io.File(context.filesDir, "telemetry/samples.jsonl"), 1000)

    /** Report cadence; follows the server's `nextReportIn` (default 60 s). */
    val schedule = ReportSchedule()

    private val encodeJson = Json { ignoreUnknownKeys = true; encodeDefaults = false }

    /**
     * Send telemetry only if the report interval has elapsed. Safe to call on every poll.
     * Returns null when not due.
     */
    suspend fun reportIfDue(serverUrl: String, deviceId: String): Boolean? {
        if (!schedule.isDue(System.currentTimeMillis())) return null
        return sendTelemetrySuspend(serverUrl, deviceId)
    }

    /**
     * Collect a sample, queue it, then flush the queue (oldest first) with the session token
     * header (contract C1). Returns true when the queue is empty afterwards.
     */
    suspend fun sendTelemetrySuspend(serverUrl: String, deviceId: String): Boolean {
        return try {
            schedule.markReported(System.currentTimeMillis())
            refreshLocation()
            buffer.append(encodeJson.encodeToString(collectTelemetry().copy(collectedAt = System.currentTimeMillis())))
            val client = clientFor(serverUrl)
            val base = "${serverUrl.trimEnd('/')}/api/devices/$deviceId/telemetry"
            val flusher = TelemetryFlusher(
                buffer,
                sendBatch = { samples -> postBatch(client, base, samples) },
                sendSingle = { sample -> postSingle(client, base, sample) }
            )
            val success = flusher.flush()

            if (success) {
                Log.i(TAG, "Telemetry sent successfully")
                sessionStorage.updateSyncStatus(true)
            } else {
                Log.w(TAG, "Telemetry send failed, ${buffer.size} samples buffered")
                sessionStorage.updateSyncStatus(false, "Server rejected telemetry")
            }
            success
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.e(TAG, "Failed to send telemetry", e)
            sessionStorage.updateSyncStatus(false, e.message ?: "Connection failed")
            false
        }
    }

    private suspend fun postSingle(client: HttpClient, base: String, sample: String): Boolean = try {
        val response = client.post(base) { contentType(ContentType.Application.Json); setBody(sample) }
        if (response.status.isSuccess()) {
            runCatching { schedule.update(TelemetryValues.nextReportMs(response.bodyAsText())) }
            true
        } else false
    } catch (e: CancellationException) { throw e } catch (e: Exception) { false }

    private suspend fun postBatch(client: HttpClient, base: String, samples: List<String>): BatchOutcome = try {
        val response = client.post("$base/batch") {
            contentType(ContentType.Application.Json)
            setBody("{\"samples\":[" + samples.joinToString(",") + "]}")
        }
        when {
            response.status.isSuccess() -> {
                // The batch answer carries nextReportIn (ms) too
                runCatching { schedule.update(TelemetryValues.nextReportMs(response.bodyAsText())) }
                BatchOutcome.OK
            }
            response.status == HttpStatusCode.NotFound -> BatchOutcome.NOT_FOUND
            else -> BatchOutcome.FAILED
        }
    } catch (e: CancellationException) { throw e } catch (e: Exception) { BatchOutcome.FAILED }

    // ==================== Battery ====================

    private fun getBatteryLevel(): Int {
        val batteryManager = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        return batteryManager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
    }

    private fun isCharging(): Boolean {
        val intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        return status == BatteryManager.BATTERY_STATUS_CHARGING ||
                status == BatteryManager.BATTERY_STATUS_FULL
    }

    private fun getBatteryHealth(): String {
        val intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        return when (intent?.getIntExtra(BatteryManager.EXTRA_HEALTH, -1)) {
            BatteryManager.BATTERY_HEALTH_GOOD -> "good"
            BatteryManager.BATTERY_HEALTH_OVERHEAT -> "overheat"
            BatteryManager.BATTERY_HEALTH_DEAD -> "dead"
            BatteryManager.BATTERY_HEALTH_OVER_VOLTAGE -> "over_voltage"
            BatteryManager.BATTERY_HEALTH_COLD -> "cold"
            else -> "unknown"
        }
    }

    // ==================== Network ====================

    private fun getNetworkType(): String {
        val connectivityManager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = connectivityManager.activeNetwork ?: return "none"
        val capabilities = connectivityManager.getNetworkCapabilities(network) ?: return "none"

        return when {
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
    }

    private fun getWifiSsid(): String? {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED) {
            return null
        }

        val wifiManager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        @Suppress("DEPRECATION")
        val info = wifiManager.connectionInfo
        val ssid = info?.ssid?.removePrefix("\"")?.removeSuffix("\"")
        return if (ssid == "<unknown ssid>") null else ssid
    }

    private fun getIpAddress(): String? {
        val wifiManager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        @Suppress("DEPRECATION")
        val ipInt = wifiManager.connectionInfo?.ipAddress ?: return null
        if (ipInt == 0) return null

        return "${ipInt and 0xFF}.${(ipInt shr 8) and 0xFF}.${(ipInt shr 16) and 0xFF}.${(ipInt shr 24) and 0xFF}"
    }

    private fun getSignalStrength(): Int? {
        val wifiManager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        @Suppress("DEPRECATION")
        val rssi = wifiManager.connectionInfo?.rssi ?: return null
        return TelemetryValues.signalDbm(rssi) // dBm, as the server's schema expects
    }

    // ==================== Storage ====================

    private fun getUsedStorage(): Long {
        val stat = StatFs(Environment.getDataDirectory().path)
        return stat.totalBytes - stat.availableBytes
    }

    private fun getTotalStorage(): Long {
        val stat = StatFs(Environment.getDataDirectory().path)
        return stat.totalBytes
    }

    // ==================== Memory ====================

    private fun getUsedMemory(): Long {
        val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memInfo = ActivityManager.MemoryInfo()
        activityManager.getMemoryInfo(memInfo)
        return memInfo.totalMem - memInfo.availMem
    }

    private fun getTotalMemory(): Long {
        val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memInfo = ActivityManager.MemoryInfo()
        activityManager.getMemoryInfo(memInfo)
        return memInfo.totalMem
    }

    // ==================== Display ====================

    private fun isScreenOn(): Boolean {
        val powerManager = context.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
        return powerManager.isInteractive
    }

    private fun getBrightness(): Int {
        return try {
            Settings.System.getInt(context.contentResolver, Settings.System.SCREEN_BRIGHTNESS)
        } catch (e: Exception) {
            -1
        }
    }

    // ==================== Location ====================

    /** Fixes gathered by [refreshLocation]; filtered by [LocationPolicy] on every read, never trusted forever. */
    private var refreshedFix: LocationFix? = null

    private fun locationAllowed(): Boolean {
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
        val enabled = lm != null && (Build.VERSION.SDK_INT < Build.VERSION_CODES.P || lm.isLocationEnabled)
        return LocationPolicy.shouldRequest(enabled, granted)
    }

    /** Ask the platform for a fresh fix (API 30+), waiting at most 5 s. */
    @Suppress("MissingPermission")
    private suspend fun refreshLocation() {
        if (!locationAllowed() || Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val provider = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            .firstOrNull { runCatching { lm.isProviderEnabled(it) }.getOrDefault(false) } ?: return
        val loc = withTimeoutOrNull(5_000) {
            suspendCancellableCoroutine<android.location.Location?> { cont ->
                val cancel = android.os.CancellationSignal()
                cont.invokeOnCancellation { cancel.cancel() }
                try {
                    lm.getCurrentLocation(provider, cancel, ContextCompat.getMainExecutor(context)) {
                        if (cont.isActive) cont.resume(it)
                    }
                } catch (e: Exception) { if (cont.isActive) cont.resume(null) }
            }
        }
        if (loc != null) refreshedFix = LocationFix(loc.latitude, loc.longitude, loc.accuracy, loc.time)
    }

    private fun getLocation(): LocationFix? {
        if (!locationAllowed()) return null
        val locationManager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val fixes = mutableListOf<LocationFix>()
        refreshedFix?.let { fixes += it }
        for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)) {
            try {
                if (locationManager.isProviderEnabled(provider)) {
                    @Suppress("MissingPermission")
                    locationManager.getLastKnownLocation(provider)?.let {
                        fixes += LocationFix(it.latitude, it.longitude, it.accuracy, it.time)
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to get location from $provider: ${e.message}")
            }
        }
        return LocationPolicy.select(fixes, System.currentTimeMillis())
    }

    private fun getLatitude(): Double? = getLocation()?.latitude
    private fun getLongitude(): Double? = getLocation()?.longitude
    private fun getLocationAccuracy(): Float? = getLocation()?.accuracy

    // ==================== System ====================

    private fun getUptimeMs(): Long = SystemClock.elapsedRealtime()

    private fun getSecurityPatch(): String? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            Build.VERSION.SECURITY_PATCH
        } else {
            null
        }
    }
}

/**
 * Telemetry data structure matching server's TelemetryInput.
 */
@Serializable
data class TelemetryData(
    val batteryLevel: Int? = null,
    val batteryCharging: Boolean? = null,
    val batteryHealth: String? = null,
    val networkType: String? = null,
    val networkSsid: String? = null,
    val ipAddress: String? = null,
    val signalStrength: Int? = null,
    val storageUsedBytes: Long? = null,
    val storageTotalBytes: Long? = null,
    val memoryUsedBytes: Long? = null,
    val memoryTotalBytes: Long? = null,
    val screenOn: Boolean? = null,
    val brightness: Int? = null,
    val latitude: Double? = null,
    val longitude: Double? = null,
    val locationAccuracy: Float? = null,
    val uptimeMs: Long? = null,
    val androidSecurityPatch: String? = null,
    /** Epoch ms when the sample was taken; lets the server place buffered samples correctly. */
    val collectedAt: Long? = null,
    val kioskActive: Boolean? = null,
    /** Always sent (null when no kiosk) so the server can clear a stale package. */
    @OptIn(ExperimentalSerializationApi::class) @EncodeDefault val kioskPackage: String? = null,
    val lockTask: Boolean? = null,
    val protectedPackages: List<String>? = null
)
