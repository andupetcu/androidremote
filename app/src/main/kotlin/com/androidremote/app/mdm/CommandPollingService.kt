package com.androidremote.app.mdm

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.androidremote.app.MainActivity
import com.androidremote.app.admin.DeviceOwnerManager
import com.androidremote.app.api.CommandApiClient
import com.androidremote.app.api.CommandApiException
import com.androidremote.app.api.DeviceCommand
import com.androidremote.app.ui.SessionStorage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Foreground service that polls the MDM server for pending commands.
 *
 * Commands are fetched at regular intervals and executed locally:
 * - INSTALL_APK: Download and install an APK
 * - UNINSTALL_APP: Uninstall a package
 * - LOCK: Lock the device screen
 * - REBOOT: Reboot the device
 * - WIPE: Factory reset the device
 * - START_REMOTE: Start a remote control session
 *
 * The service runs as a foreground service with a persistent notification.
 * It uses START_STICKY to ensure it restarts if killed by the system.
 */
class CommandPollingService : Service() {

    companion object {
        private const val TAG = "CommandPollingService"
        private const val NOTIFICATION_ID = 1002
        private const val CHANNEL_ID = "mdm_command_channel"

        /** Default polling interval: 30 seconds */
        private const val DEFAULT_POLL_INTERVAL_MS = 30_000L

        /** Minimum polling interval: 10 seconds */
        private const val MIN_POLL_INTERVAL_MS = 10_000L

        /** Maximum polling interval: 5 minutes */
        private const val MAX_POLL_INTERVAL_MS = 300_000L

        /** Intent extra for custom polling interval */
        const val EXTRA_POLL_INTERVAL = "poll_interval"

        fun startService(context: Context, pollIntervalMs: Long = DEFAULT_POLL_INTERVAL_MS) {
            val intent = Intent(context, CommandPollingService::class.java).apply {
                putExtra(EXTRA_POLL_INTERVAL, pollIntervalMs)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stopService(context: Context) {
            context.stopService(Intent(context, CommandPollingService::class.java))
        }
    }

    private val binder = LocalBinder()
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private lateinit var sessionStorage: SessionStorage
    private lateinit var deviceOwnerManager: DeviceOwnerManager
    private lateinit var silentInstaller: SilentPackageInstaller
    private lateinit var telemetryCollector: TelemetryCollector

    private var commandApiClient: CommandApiClient? = null
    private var pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
    private var isPolling = false
    private var pollCount = 0
    private var httpBaseUrl: String? = null

    /** Send telemetry every N polls (e.g., 6 polls = 30 seconds with 5s interval) */
    private val TELEMETRY_POLL_INTERVAL = 6

    inner class LocalBinder : Binder() {
        fun getService(): CommandPollingService = this@CommandPollingService
    }

    override fun onCreate() {
        super.onCreate()
        Log.d(TAG, "CommandPollingService created")

        sessionStorage = SessionStorage.create(this)
        deviceOwnerManager = DeviceOwnerManager(this)
        silentInstaller = SilentPackageInstaller(this)
        telemetryCollector = TelemetryCollector(this)

        createNotificationChannel()
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.d(TAG, "CommandPollingService started")

        // Handle stop action
        if (intent?.action == "STOP") {
            stopPolling()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        // Get polling interval from intent
        val requestedInterval = intent?.getLongExtra(EXTRA_POLL_INTERVAL, DEFAULT_POLL_INTERVAL_MS)
            ?: DEFAULT_POLL_INTERVAL_MS
        pollIntervalMs = requestedInterval.coerceIn(MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS)

        // Start foreground with notification
        val notification = createNotification()
        startForeground(NOTIFICATION_ID, notification)

        // Initialize API client and start polling
        initializeAndStartPolling()

        return START_STICKY
    }

    override fun onDestroy() {
        Log.d(TAG, "CommandPollingService destroyed")
        stopPolling()
        commandApiClient?.close()
        serviceScope.cancel()
        super.onDestroy()
    }

    /**
     * Initialize the API client and start polling.
     */
    private fun initializeAndStartPolling() {
        val deviceId = sessionStorage.getDeviceId()
        val serverUrl = sessionStorage.getServerUrl()

        if (deviceId == null || serverUrl == null) {
            Log.e(TAG, "Device not enrolled - cannot start polling")
            stopSelf()
            return
        }

        // Convert WebSocket URL to HTTP URL
        val httpUrl = serverUrl
            .replace("wss://", "https://")
            .replace("ws://", "http://")
            .removeSuffix("/ws")

        // Save HTTP base URL for telemetry
        httpBaseUrl = httpUrl

        commandApiClient = CommandApiClient(httpUrl, deviceId)

        // Apply silent mode from saved preferences
        applySavedSilentMode()

        // Send initial telemetry immediately
        serviceScope.launch {
            try {
                val success = telemetryCollector.sendTelemetry(httpUrl, deviceId)
                Log.i(TAG, "Initial telemetry sent: $success")
            } catch (e: Exception) {
                Log.w(TAG, "Failed to send initial telemetry: ${e.message}")
            }
        }

        startPolling()
    }

    /**
     * Apply silent mode if it was previously enabled (survives service restart).
     */
    private fun applySavedSilentMode() {
        val mdmPrefs = getSharedPreferences("mdm_settings", Context.MODE_PRIVATE)
        val silentModeEnabled = mdmPrefs.getBoolean("silent_mode", false)

        if (silentModeEnabled) {
            val success = deviceOwnerManager.enableSilentMode()
            Log.i(TAG, "Applied saved silent mode setting: $success")
        }
    }

    /**
     * Start the polling loop.
     */
    private fun startPolling() {
        if (isPolling) {
            Log.d(TAG, "Already polling")
            return
        }

        isPolling = true
        Log.i(TAG, "Starting command polling (interval: ${pollIntervalMs}ms)")

        serviceScope.launch {
            while (isActive && isPolling) {
                try {
                    fetchAndExecuteCommands()

                    // Send telemetry periodically
                    pollCount++
                    if (pollCount >= TELEMETRY_POLL_INTERVAL) {
                        pollCount = 0
                        sendPeriodicTelemetry()
                    }
                } catch (e: CommandApiException) {
                    Log.e(TAG, "Command API error: ${e.message}")
                    // Continue polling even on errors
                } catch (e: Exception) {
                    Log.e(TAG, "Unexpected error during polling", e)
                }

                delay(pollIntervalMs)
            }
        }
    }

    /**
     * Stop the polling loop.
     */
    private fun stopPolling() {
        Log.i(TAG, "Stopping command polling")
        isPolling = false
    }

    /**
     * Send telemetry data to the server periodically.
     */
    private fun sendPeriodicTelemetry() {
        val serverUrl = httpBaseUrl ?: return
        val deviceId = sessionStorage.getDeviceId() ?: return

        try {
            val success = telemetryCollector.sendTelemetry(serverUrl, deviceId)
            if (success) {
                Log.d(TAG, "Periodic telemetry sent")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to send periodic telemetry: ${e.message}")
        }
    }

    /**
     * Fetch pending commands and execute them.
     */
    private suspend fun fetchAndExecuteCommands() {
        val client = commandApiClient ?: return

        val commands = client.getPendingCommands()
        if (commands.isEmpty()) {
            Log.d(TAG, "No pending commands")
            return
        }

        Log.i(TAG, "Received ${commands.size} pending commands")

        for (command in commands) {
            executeCommand(command)
        }
    }

    /**
     * Execute a single command.
     */
    private suspend fun executeCommand(command: DeviceCommand) {
        val client = commandApiClient ?: return

        Log.i(TAG, "Executing command: ${command.type} (${command.id})")

        // Mark as executing
        client.markExecuting(command.id)

        try {
            val result = when (command.type) {
                "INSTALL_APK" -> executeInstallApk(command)
                "UNINSTALL_APP" -> executeUninstallApp(command)
                "LOCK" -> executeLock()
                "REBOOT" -> executeReboot()
                "WIPE" -> executeWipe(command)
                "START_REMOTE" -> executeStartRemote(command)
                "TAKE_SCREENSHOT" -> executeTakeScreenshot()
                "GET_LOCATION" -> executeGetLocation()
                "REFRESH_TELEMETRY" -> executeRefreshTelemetry()
                "SYNC_APPS" -> executeSyncApps()
                "SYNC_POLICY" -> executeSyncPolicy(command)
                else -> CommandResult.failure("Unknown command type: ${command.type}")
            }

            // Report result
            if (result.success) {
                Log.i(TAG, "Command ${command.id} completed successfully")
                client.markCompleted(command.id)
            } else {
                Log.w(TAG, "Command ${command.id} failed: ${result.error}")
                client.markFailed(command.id, result.error ?: "Unknown error")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Command ${command.id} threw exception", e)
            client.markFailed(command.id, "Exception: ${e.message}")
        }
    }

    // ========================================
    // Command Implementations
    // ========================================

    private suspend fun executeInstallApk(command: DeviceCommand): CommandResult {
        val urlPath = command.payload["url"]?.jsonPrimitive?.content
        val packageName = command.payload["packageName"]?.jsonPrimitive?.content

        if (urlPath == null || packageName == null) {
            return CommandResult.failure("Missing url or packageName in payload")
        }

        // Extract app options
        val autoStartAfterInstall = command.payload["autoStartAfterInstall"]?.jsonPrimitive?.content?.toBoolean() ?: false
        val foregroundApp = command.payload["foregroundApp"]?.jsonPrimitive?.content?.toBoolean() ?: false
        val autoStartOnBoot = command.payload["autoStartOnBoot"]?.jsonPrimitive?.content?.toBoolean() ?: false

        // If the URL is relative (starts with /), prepend the server base URL
        val url = if (urlPath.startsWith("/")) {
            val baseUrl = httpBaseUrl ?: return CommandResult.failure("Server URL not configured")
            "$baseUrl$urlPath"
        } else {
            urlPath
        }

        // Self-update: when installing our own package, the process will be killed.
        // Ensure auto-restart by saving boot preference BEFORE installing.
        val isSelfUpdate = packageName == applicationContext.packageName
        if (isSelfUpdate) {
            Log.i(TAG, "Self-update detected — saving boot-start preference before install")
            saveBootStartApp(packageName, false)
        }

        Log.d(TAG, "Installing APK from: $url (autoStart=$autoStartAfterInstall, foreground=$foregroundApp, bootStart=$autoStartOnBoot, selfUpdate=$isSelfUpdate)")

        val installResult = silentInstaller.installFromUrl(url, packageName)

        return when (installResult) {
            is InstallResult.Success -> {
                // Save boot start preference if enabled
                if (autoStartOnBoot || foregroundApp) {
                    saveBootStartApp(packageName, foregroundApp)
                }

                // Auto-start the app after installation if requested
                // Add delay to allow package manager to register the new app
                if (autoStartAfterInstall || foregroundApp) {
                    Thread.sleep(2000) // Wait for PM to update
                    launchAppWithRetry(packageName, foregroundApp)
                }

                CommandResult.success()
            }
            is InstallResult.UserPromptShown -> {
                // Save preferences even when user is prompted - they'll apply after manual install
                if (autoStartOnBoot || foregroundApp) {
                    saveBootStartApp(packageName, foregroundApp)
                }
                CommandResult.success()
            }
            is InstallResult.Failure -> CommandResult.failure("Install failed: ${installResult.message}")
        }
    }

    /**
     * Save an app's boot start preference to SharedPreferences.
     */
    private fun saveBootStartApp(packageName: String, isForeground: Boolean) {
        val prefs = getSharedPreferences("boot_apps", Context.MODE_PRIVATE)
        val editor = prefs.edit()

        // If this is the foreground app, clear any previous foreground app
        if (isForeground) {
            prefs.all.keys.forEach { key ->
                if (prefs.getBoolean(key, false)) {
                    editor.remove(key)
                }
            }
        }

        // Store: "packageName" -> true (foreground) or false (regular boot start)
        editor.putBoolean(packageName, isForeground)
        editor.apply()

        Log.i(TAG, "Saved boot start preference: $packageName (foreground=$isForeground)")
    }

    /**
     * Launch an installed app, optionally bringing it to the foreground.
     */
    private fun launchApp(packageName: String, foreground: Boolean): Boolean {
        try {
            val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
            if (launchIntent != null) {
                launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                if (foreground) {
                    launchIntent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
                    launchIntent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
                }
                startActivity(launchIntent)
                Log.i(TAG, "Launched app: $packageName (foreground=$foreground)")
                return true
            } else {
                Log.w(TAG, "No launch intent found for: $packageName")
                return false
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to launch app: $packageName", e)
            return false
        }
    }

    /**
     * Launch app with retry - useful after installation when PM might not be ready.
     */
    private fun launchAppWithRetry(packageName: String, foreground: Boolean, maxRetries: Int = 3) {
        for (attempt in 1..maxRetries) {
            if (launchApp(packageName, foreground)) {
                return
            }
            if (attempt < maxRetries) {
                Log.d(TAG, "Launch attempt $attempt failed, retrying in 1s...")
                Thread.sleep(1000)
            }
        }
        Log.e(TAG, "Failed to launch $packageName after $maxRetries attempts")
    }

    private suspend fun executeUninstallApp(command: DeviceCommand): CommandResult {
        val packageName = command.payload["packageName"]?.jsonPrimitive?.content
            ?: return CommandResult.failure("Missing packageName in payload")

        return when (val result = silentInstaller.uninstall(packageName)) {
            is InstallResult.Success -> CommandResult.success()
            is InstallResult.UserPromptShown -> CommandResult.success() // User was prompted
            is InstallResult.Failure -> CommandResult.failure("Uninstall failed: ${result.message}")
        }
    }

    private fun executeLock(): CommandResult {
        return if (deviceOwnerManager.hasMdmPrivileges()) {
            deviceOwnerManager.lockDevice()
            CommandResult.success()
        } else {
            CommandResult.failure("Device lock requires Device Admin privileges")
        }
    }

    private fun executeReboot(): CommandResult {
        if (!deviceOwnerManager.isDeviceOwner()) {
            return CommandResult.failure("Reboot requires Device Owner privileges")
        }

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            return CommandResult.failure("Reboot requires Android 7.0+")
        }

        deviceOwnerManager.rebootDevice()
        return CommandResult.success()
    }

    private fun executeWipe(command: DeviceCommand): CommandResult {
        if (!deviceOwnerManager.isDeviceOwner()) {
            return CommandResult.failure("Wipe requires Device Owner privileges")
        }

        val keepData = command.payload["keepData"]?.jsonPrimitive?.content?.toBoolean() ?: false
        val flags = if (!keepData) {
            android.app.admin.DevicePolicyManager.WIPE_EXTERNAL_STORAGE
        } else {
            0
        }

        Log.w(TAG, "EXECUTING DEVICE WIPE - keepData=$keepData")
        deviceOwnerManager.wipeDevice(flags)

        // Note: Device will wipe before this returns
        return CommandResult.success()
    }

    private fun executeStartRemote(command: DeviceCommand): CommandResult {
        val signalingUrl = command.payload["signalingUrl"]?.jsonPrimitive?.content

        if (signalingUrl == null) {
            return CommandResult.failure("Missing signalingUrl in payload")
        }

        // Start the RemoteSessionService with auto-connect
        val intent = Intent(this, com.androidremote.app.service.RemoteSessionService::class.java).apply {
            putExtra(com.androidremote.app.service.RemoteSessionService.EXTRA_AUTO_START, true)
            putExtra(com.androidremote.app.service.RemoteSessionService.EXTRA_SERVER_URL, signalingUrl)
            putExtra(
                com.androidremote.app.service.RemoteSessionService.EXTRA_SESSION_TOKEN,
                sessionStorage.getSessionToken()
            )
            putExtra(
                com.androidremote.app.service.RemoteSessionService.EXTRA_DEVICE_ID,
                sessionStorage.getDeviceId()
            )
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }

        Log.i(TAG, "Started remote session service for: $signalingUrl")
        return CommandResult.success()
    }

    private fun executeTakeScreenshot(): CommandResult {
        // Screenshot requires MediaProjection which needs user consent via Activity
        // For now, return an error indicating this limitation
        // A full implementation would trigger the ScreenCaptureService
        return CommandResult.failure("Screenshot requires an active remote session or user consent")
    }

    private fun executeGetLocation(): CommandResult {
        // Check for location permission
        val hasPermission = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED

        if (!hasPermission) {
            return CommandResult.failure("Location permission not granted")
        }

        val locationManager = getSystemService(Context.LOCATION_SERVICE) as LocationManager

        // Try to get the last known location from various providers
        val providers = listOf(
            LocationManager.GPS_PROVIDER,
            LocationManager.NETWORK_PROVIDER,
            LocationManager.PASSIVE_PROVIDER
        )

        var bestLocation: Location? = null

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

        return if (bestLocation != null) {
            Log.i(TAG, "Location: ${bestLocation.latitude}, ${bestLocation.longitude}")
            // Send telemetry update with the location
            val serverUrl = httpBaseUrl
            val deviceId = sessionStorage.getDeviceId()
            if (serverUrl != null && deviceId != null) {
                telemetryCollector.sendTelemetry(serverUrl, deviceId)
            }
            CommandResult.success()
        } else {
            CommandResult.failure("No location available. Ensure GPS is enabled.")
        }
    }

    private fun executeRefreshTelemetry(): CommandResult {
        Log.i(TAG, "Telemetry refresh requested")

        val serverUrl = httpBaseUrl
        val deviceId = sessionStorage.getDeviceId()

        if (serverUrl == null || deviceId == null) {
            return CommandResult.failure("Device not enrolled - missing server URL or device ID")
        }

        val success = telemetryCollector.sendTelemetry(serverUrl, deviceId)
        return if (success) {
            CommandResult.success()
        } else {
            CommandResult.failure("Failed to send telemetry to server")
        }
    }

    private fun executeSyncApps(): CommandResult {
        // Get list of installed applications and send to server
        val pm = packageManager
        val packages = pm.getInstalledPackages(0)
        Log.i(TAG, "Syncing ${packages.size} installed apps")
        // TODO: Implement actual app list upload to server
        // For now, just return success - the app inventory sync needs its own endpoint
        return CommandResult.success()
    }

    private fun executeSyncPolicy(command: DeviceCommand): CommandResult {
        Log.i(TAG, "Syncing policy settings")

        // Extract policy settings from payload
        val silentMode = command.payload["silentMode"]?.jsonPrimitive?.content?.toBoolean() ?: false
        val kioskMode = command.payload["kioskMode"]?.jsonPrimitive?.content?.toBoolean() ?: false

        // Save settings for re-applying after boot
        val mdmPrefs = getSharedPreferences("mdm_settings", Context.MODE_PRIVATE)
        mdmPrefs.edit()
            .putBoolean("silent_mode", silentMode)
            .putBoolean("kiosk_mode", kioskMode)
            .apply()

        // Apply silent mode
        if (silentMode) {
            val success = deviceOwnerManager.enableSilentMode()
            Log.i(TAG, "Silent mode enabled: $success")
        } else {
            val success = deviceOwnerManager.disableSilentMode()
            Log.i(TAG, "Silent mode disabled: $success")
        }

        // Process required apps - set boot preferences for already-installed apps
        val requiredAppsJson = command.payload["requiredApps"]
        if (requiredAppsJson != null) {
            try {
                val requiredApps = requiredAppsJson.jsonArray
                Log.i(TAG, "Processing ${requiredApps.size} required apps for boot preferences")

                for (appElement in requiredApps) {
                    val appObj = appElement.jsonObject
                    val packageName = appObj["packageName"]?.jsonPrimitive?.content ?: continue
                    // Handle both boolean primitives and string representations
                    val foregroundApp = appObj["foregroundApp"]?.jsonPrimitive?.content?.toBooleanStrictOrNull() ?: false
                    val autoStartOnBoot = appObj["autoStartOnBoot"]?.jsonPrimitive?.content?.toBooleanStrictOrNull() ?: false

                    Log.d(TAG, "App config: $packageName, foreground=$foregroundApp, bootStart=$autoStartOnBoot")

                    // Check if app is installed
                    val isInstalled = try {
                        packageManager.getPackageInfo(packageName, 0)
                        true
                    } catch (e: PackageManager.NameNotFoundException) {
                        Log.d(TAG, "App not installed: $packageName")
                        false
                    }

                    if (isInstalled) {
                        if (foregroundApp || autoStartOnBoot) {
                            saveBootStartApp(packageName, foregroundApp)
                            Log.i(TAG, "Set boot preference for $packageName: foreground=$foregroundApp, bootStart=$autoStartOnBoot")
                        }

                        // If this is the foreground app and we just synced, launch it now
                        if (foregroundApp) {
                            Log.i(TAG, "Launching foreground app: $packageName")
                            launchAppWithRetry(packageName, true)
                        }
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to process requiredApps: ${e.message}", e)
            }
        }

        // TODO: Apply kiosk mode (lock task mode) if enabled
        // This requires additional setup

        return CommandResult.success()
    }

    // ========================================
    // Notification
    // ========================================

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "MDM Service",
                NotificationManager.IMPORTANCE_MIN  // Minimally visible - no sound, no heads-up
            ).apply {
                description = "Background service for device management"
                setShowBadge(false)
                setSound(null, null)
                enableLights(false)
                enableVibration(false)
            }

            val notificationManager = getSystemService(NotificationManager::class.java)
            notificationManager.createNotificationChannel(channel)
        }
    }

    private fun createNotification(): Notification {
        val openIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, openIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        // Minimal notification - required by Android for foreground services
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Device Managed")
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .setPriority(NotificationCompat.PRIORITY_MIN)  // Lowest priority
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)  // Hide on lock screen
            .setSilent(true)  // No sound
            .build()
    }
}

/**
 * Result of command execution.
 */
data class CommandResult(
    val success: Boolean,
    val error: String? = null
) {
    companion object {
        fun success() = CommandResult(true)
        fun failure(error: String) = CommandResult(false, error)
    }
}
