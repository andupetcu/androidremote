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
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import com.androidremote.app.api.CommandApiClient
import com.androidremote.app.api.DeviceHttpClient
import com.androidremote.app.ui.SessionStorage
import io.ktor.client.HttpClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking

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

    /**
     * Collect all telemetry data.
     * Each metric is collected independently - failures don't stop other metrics.
     */
    fun collectTelemetry(): TelemetryData {
        return TelemetryData(
            // Battery
            batteryLevel = safeCall { getBatteryLevel() },
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
        )
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

    /**
     * Send telemetry to the server with the session token header (contract C1).
     */
    suspend fun sendTelemetrySuspend(serverUrl: String, deviceId: String): Boolean {
        return try {
            val body = json.encodeToString(collectTelemetry())
            val success = CommandApiClient(serverUrl, deviceId, clientFor(serverUrl)).postTelemetry(body)

            if (success) {
                Log.i(TAG, "Telemetry sent successfully")
                sessionStorage.updateSyncStatus(true)
            } else {
                Log.w(TAG, "Telemetry send failed")
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
        return WifiManager.calculateSignalLevel(rssi, 100)
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

    private var cachedLocation: android.location.Location? = null

    private fun getLocation(): android.location.Location? {
        if (cachedLocation != null) return cachedLocation

        if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED) {
            return null
        }

        val locationManager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager

        val providers = listOf(
            LocationManager.GPS_PROVIDER,
            LocationManager.NETWORK_PROVIDER,
            LocationManager.PASSIVE_PROVIDER
        )

        var bestLocation: android.location.Location? = null

        for (provider in providers) {
            try {
                if (locationManager.isProviderEnabled(provider)) {
                    @Suppress("MissingPermission")
                    val location = locationManager.getLastKnownLocation(provider)
                    if (location != null) {
                        if (bestLocation == null || location.accuracy < bestLocation.accuracy) {
                            bestLocation = location
                        }
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to get location from $provider: ${e.message}")
            }
        }

        cachedLocation = bestLocation
        return bestLocation
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
    val androidSecurityPatch: String? = null
)
