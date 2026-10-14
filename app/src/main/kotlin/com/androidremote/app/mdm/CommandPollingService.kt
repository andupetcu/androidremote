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
import com.androidremote.app.api.AppUpdatesResponse
import com.androidremote.app.api.DeviceHttpClient
import com.androidremote.app.kiosk.AppManagement
import com.androidremote.app.kiosk.BootApps
import com.androidremote.app.kiosk.BootAppsMerge
import com.androidremote.app.kiosk.KioskController
import com.androidremote.app.kiosk.MaintenanceWindow
import com.androidremote.app.kiosk.PolicyUpdate
import com.androidremote.app.kiosk.TargetPackageReceiver
import com.androidremote.app.kiosk.UpdatePolicy
import com.androidremote.app.kiosk.WipeGuard
import kotlinx.serialization.json.JsonObject
import io.ktor.client.HttpClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull
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

        /** True while an instance of the service is alive. Read by the WorkManager watchdog. */
        @Volatile
        var isRunning: Boolean = false
            private set

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

    /** Installs, uninstalls and app updates run here so they never hold up the poll loop. */
    private val installScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var appUpdateJob: Job? = null
    private var pollJob: Job? = null

    private lateinit var sessionStorage: SessionStorage
    private lateinit var deviceOwnerManager: DeviceOwnerManager
    private lateinit var silentInstaller: SilentPackageInstaller
    private lateinit var telemetryCollector: TelemetryCollector
    private lateinit var kioskController: KioskController
    private lateinit var appManagement: AppManagement
    private var packageReceiver: TargetPackageReceiver? = null
    private var pollingDeviceId: String? = null

    private var commandApiClient: CommandApiClient? = null
    private var httpClient: HttpClient? = null
    private var processor: CommandProcessor? = null
    private var pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
    private var isPolling = false
    private var pollCount = 0
    private var httpBaseUrl: String? = null

    /** Check for app updates every N polls */
    private val UPDATE_CHECK_POLL_INTERVAL = 6

    inner class LocalBinder : Binder() {
        fun getService(): CommandPollingService = this@CommandPollingService
    }

    override fun onCreate() {
        super.onCreate()
        Log.d(TAG, "CommandPollingService created")
        isRunning = true

        sessionStorage = SessionStorage.create(this)
        deviceOwnerManager = DeviceOwnerManager(this)
        silentInstaller = SilentPackageInstaller(this)
        telemetryCollector = TelemetryCollector(this)
        kioskController = KioskController(this, deviceOwnerManager)
        appManagement = AppManagement(this, deviceOwnerManager)

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

        // A fresh start (boot, re-enrolment, user action) gets one new chance; a 401/404 sets the flag again
        EnrollmentState.clear(this)

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
        isRunning = false
        stopPolling()
        packageReceiver?.let { runCatching { unregisterReceiver(it) } }
        packageReceiver = null
        commandApiClient?.close()
        httpClient?.close()
        serviceScope.cancel()
        installScope.cancel()
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

        // Idempotent (AM-10): boot, self-update and MainActivity may all start the service
        if (isPolling && pollingDeviceId == deviceId) {
            Log.d(TAG, "Already polling for $deviceId")
            return
        }
        pollingDeviceId = deviceId

        // Convert WebSocket URL to HTTP URL
        val httpUrl = serverUrl
            .replace("wss://", "https://")
            .replace("ws://", "http://")
            .removeSuffix("/ws")

        // Save HTTP base URL for telemetry
        httpBaseUrl = httpUrl

        // One authenticated client (X-Session-Token) for polling, acks, inventory and app updates
        httpClient?.close()
        val client = DeviceHttpClient.create(httpUrl, { sessionStorage.getSessionToken() })
        httpClient = client
        val api = CommandApiClient(httpUrl, deviceId, client)
        commandApiClient = api
        processor = CommandProcessor(
            acks = api,
            store = PrefsCommandStateStore(getSharedPreferences("command_state", Context.MODE_PRIVATE)),
            handler = { dispatchCommand(it) }
        )

        kioskController.tryGrantUsageAccess()
        if (packageReceiver == null) {
            val r = TargetPackageReceiver(kioskController)
            ContextCompat.registerReceiver(this, r, TargetPackageReceiver.filter(), ContextCompat.RECEIVER_EXPORTED)
            packageReceiver = r
        }

        BatteryExemption.requestIfDeviceOwner(this, deviceOwnerManager)
        PollingWatchdog.schedule(this)

        // Apply silent mode from saved preferences
        applySavedSilentMode()

        // Leave system admin-install notifications visible. The upstream
        // AdminNotificationManager implementation is not included in this project.

        // Send initial telemetry and app inventory immediately
        serviceScope.launch {
            try {
                val success = telemetryCollector.sendTelemetrySuspend(httpUrl, deviceId)
                Log.i(TAG, "Initial telemetry sent: $success")
            } catch (e: Exception) {
                Log.w(TAG, "Failed to send initial telemetry: ${e.message}")
            }
            try {
                val result = executeSyncApps()
                Log.i(TAG, "Initial app sync: ${if (result.success) "success" else result.error}")
            } catch (e: Exception) {
                Log.w(TAG, "Failed to sync initial apps: ${e.message}")
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

        pollJob = serviceScope.launch {
            runPollLoop(
                baseMs = pollIntervalMs,
                backoff = PollBackoff(pollIntervalMs, MAX_POLL_INTERVAL_MS),
                isActive = { isPolling },
                pollOnce = {
                    processor?.flushPendingAcks()
                    fetchAndExecuteCommands()

                    // Self-throttling telemetry (server-provided interval) and app updates must not delay polling
                    sendPeriodicTelemetry()
                    pollCount++
                    if (pollCount >= UPDATE_CHECK_POLL_INTERVAL) {
                        pollCount = 0
                        startAppUpdateCheck()
                    }
                    // Keep the kiosk / foreground app in front (AM-07)
                    kioskController.watchdogTick()
                },
                onEnrollmentInvalid = { e -> onEnrollmentInvalid(e) }
            )
        }
    }

    /** 401 or 404 on poll: stop, remember it, and say so in the notification. */
    private fun onEnrollmentInvalid(e: CommandApiException) {
        isPolling = false
        val reason = when (e.errorType) {
            com.androidremote.app.api.CommandApiErrorType.UNAUTHORIZED -> "Server rejected this device's session token"
            else -> "Device is not registered on the server"
        }
        EnrollmentState.markInvalid(this, reason)
        PollingWatchdog.cancel(this)
        try {
            getSystemService(NotificationManager::class.java).notify(
                NOTIFICATION_ID,
                NotificationCompat.Builder(this, CHANNEL_ID)
                    .setContentTitle("Enrollment invalid - re-enrol this device")
                    .setContentText(reason)
                    .setSmallIcon(android.R.drawable.ic_lock_lock)
                    .setOngoing(true)
                    .build()
            )
        } catch (ex: Exception) {
            Log.w(TAG, "Could not update notification: ${ex.message}")
        }
    }

    /**
     * Stop the polling loop.
     */
    private fun stopPolling() {
        Log.i(TAG, "Stopping command polling")
        isPolling = false
        pollJob?.cancel()
    }

    /**
     * Send telemetry data to the server periodically.
     */
    private suspend fun sendPeriodicTelemetry() {
        val serverUrl = httpBaseUrl ?: return
        val deviceId = sessionStorage.getDeviceId() ?: return

        try {
            // null means the report interval has not elapsed yet
            if (telemetryCollector.reportIfDue(serverUrl, deviceId) == true) {
                Log.d(TAG, "Periodic telemetry sent")
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "Failed to send periodic telemetry: ${e.message}")
        }
    }

    /** Start the app-update check in the install scope, unless the previous one is still running. */
    private fun startAppUpdateCheck() {
        if (appUpdateJob?.isActive == true) return
        appUpdateJob = installScope.launch { checkAndInstallAppUpdates() }
    }

    /**
     * Check the server for app updates and silently install any newer versions.
     *
     * Calls GET /api/devices/:id/app-updates which returns packages where the
     * server has a newer versionCode than what is installed on the device.
     */
    private suspend fun checkAndInstallAppUpdates() {
        val baseUrl = httpBaseUrl ?: return
        val api = commandApiClient ?: return

        try {
            val body: AppUpdatesResponse = api.getAppUpdates() ?: return
            if (body.updates.isEmpty()) {
                Log.d(TAG, "No app updates available")
                return
            }

            // Installs wait for the maintenance window when one is configured (AM-08)
            val window = readUpdateWindow()
            val now = java.util.Calendar.getInstance()
            val minuteOfDay = now.get(java.util.Calendar.HOUR_OF_DAY) * 60 + now.get(java.util.Calendar.MINUTE)
            if (!UpdatePolicy.mayInstallNow(window, minuteOfDay)) {
                Log.i(TAG, "${body.updates.size} update(s) waiting for the maintenance window")
                return
            }

            Log.i(TAG, "Found ${body.updates.size} app update(s) available")

            for (update in body.updates) {
                val apkUrl = if (update.apkUrl.startsWith("/")) {
                    "$baseUrl${update.apkUrl}"
                } else {
                    update.apkUrl
                }

                Log.i(TAG, "Auto-updating ${update.packageName}: installed=${update.installedVersionCode} -> latest=${update.latestVersionCode}")

                val result = withTimeoutOrNull(CommandProcessor.INSTALL_TIMEOUT_MS) {
                    silentInstaller.installFromUrl(apkUrl, update.packageName, update.sha256, baseUrl)
                }
                when (result) {
                    is InstallResult.Success -> {
                        Log.i(TAG, "Auto-update installed: ${update.packageName}")
                        // Package replace force-stops the app; bring the target back (AM-08)
                        if (update.packageName == kioskController.target()) {
                            delay(2000)
                            kioskController.launch(update.packageName)
                        }
                    }
                    is InstallResult.Failure -> Log.w(TAG, "Auto-update failed for ${update.packageName}: ${result.message}")
                    null -> Log.w(TAG, "Auto-update timed out for ${update.packageName}")
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "Failed to check for app updates: ${e.message}")
        }
    }

    /**
     * Fetch pending commands and execute them.
     *
     * Installs and uninstalls run in their own coroutine (one at a time) so REBOOT, LOCK and the
     * rest are never queued behind a stuck install. Everything else runs inline.
     */
    private suspend fun fetchAndExecuteCommands() {
        val client = commandApiClient ?: return
        val proc = processor ?: return

        val commands = client.getPendingCommands()
        if (commands.isEmpty()) {
            Log.d(TAG, "No pending commands")
            return
        }

        Log.i(TAG, "Received ${commands.size} pending commands")

        for (command in commands) {
            if (command.type in CommandProcessor.LONG_RUNNING_TYPES) {
                installScope.launch { proc.process(command, serialize = true) }
            } else {
                proc.process(command)
            }
        }
    }

    /** Run the handler for one command. Lifecycle, timeout and dedup are in [CommandProcessor]. */
    private suspend fun dispatchCommand(command: DeviceCommand): CommandResult {
        Log.i(TAG, "Executing command: ${command.type} (${command.id})")
        return when (command.type) {
            "INSTALL_APK" -> executeInstallApk(command)
            "UNINSTALL_APP" -> executeUninstallApp(command)
            "LOCK" -> executeLock()
            "REBOOT" -> executeReboot()
            "WIPE" -> executeWipe(command)
            "SET_KIOSK" -> kioskController.setKiosk(command.payload)
            "DISABLE_APP" -> appManagement.disableApp(command.payload)
            "ENABLE_APP" -> appManagement.enableApp(command.payload)
            "LAUNCH_APP" -> executeLaunchApp(command.payload)
            "GRANT_PERMISSION" -> appManagement.grantPermission(command.payload)
            "SET_PROTECTED_PACKAGES" -> appManagement.setProtectedPackages(command.payload)
            "START_REMOTE" -> executeStartRemote(command)
            "TAKE_SCREENSHOT" -> executeTakeScreenshot()
            "GET_LOCATION" -> executeGetLocation()
            "REFRESH_TELEMETRY" -> executeRefreshTelemetry()
            "SYNC_APPS" -> executeSyncApps()
            "SYNC_POLICY" -> executeSyncPolicy(command)
            "SET_VOLUME" -> executeSetVolume(command)
            else -> CommandResult.failure("Unknown command type: ${command.type}")
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

        val baseUrl = httpBaseUrl ?: return CommandResult.failure("Server URL not configured")
        val sha256 = command.payload["sha256"]?.jsonPrimitive?.content

        // If the URL is relative (starts with /), prepend the server base URL
        val url = if (urlPath.startsWith("/")) "$baseUrl$urlPath" else urlPath

        // Self-update: when installing our own package, the process will be killed.
        // Ensure auto-restart by saving boot preference BEFORE installing.
        val isSelfUpdate = packageName == applicationContext.packageName
        if (isSelfUpdate) {
            Log.i(TAG, "Self-update detected — saving boot-start preference before install")
            saveBootStartApp(packageName, false)
        }

        Log.d(TAG, "Installing APK from: $url (autoStart=$autoStartAfterInstall, foreground=$foregroundApp, bootStart=$autoStartOnBoot, selfUpdate=$isSelfUpdate)")

        val installResult = silentInstaller.installFromUrl(url, packageName, sha256, baseUrl)

        return when (installResult) {
            is InstallResult.Success -> {
                // Keep the system's admin-install notification visible.

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
            is InstallResult.Failure -> CommandResult.failure("Install failed: ${installResult.message}")
        }
    }

    /**
     * Save an app's boot start preference to SharedPreferences.
     */
    private fun saveBootStartApp(packageName: String, isForeground: Boolean) {
        bootApps().save(packageName, isForeground)
        Log.i(TAG, "Saved boot start preference: $packageName (foreground=$isForeground)")
    }

    private fun bootApps() = BootApps(getSharedPreferences(BootApps.PREFS, Context.MODE_PRIVATE))

    private fun readUpdateWindow(): MaintenanceWindow? {
        val p = getSharedPreferences("mdm_settings", Context.MODE_PRIVATE)
        if (!p.contains("update_window_start")) return null
        return MaintenanceWindow(p.getInt("update_window_start", 0), p.getInt("update_window_end", 0))
    }

    private fun executeLaunchApp(payload: JsonObject): CommandResult {
        val pkg = payload["packageName"]?.jsonPrimitive?.content ?: return CommandResult.failure("Missing packageName")
        return if (kioskController.launch(pkg)) CommandResult.success() else CommandResult.failure("Could not launch $pkg")
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

        // AM-16: never remove the agent itself or a protected package
        appManagement.uninstallRefusal(packageName)?.let { return CommandResult.failure(it) }

        return when (val result = silentInstaller.uninstall(packageName)) {
            is InstallResult.Success -> {
                // AM-09: an uninstalled package must not stay in the boot list
                bootApps().remove(packageName)
                CommandResult.success()
            }
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

        // C10: the payload must carry confirm == this device's id
        WipeGuard.check(command.payload, sessionStorage.getDeviceId())?.let { return CommandResult.failure(it) }
        val flags = WipeGuard.flags(command.payload)

        Log.w(TAG, "EXECUTING DEVICE WIPE - flags=$flags")
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

    private suspend fun executeGetLocation(): CommandResult {
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
                telemetryCollector.sendTelemetrySuspend(serverUrl, deviceId)
            }
            CommandResult.success()
        } else {
            CommandResult.failure("No location available. Ensure GPS is enabled.")
        }
    }

    private suspend fun executeRefreshTelemetry(): CommandResult {
        Log.i(TAG, "Telemetry refresh requested")

        val serverUrl = httpBaseUrl
        val deviceId = sessionStorage.getDeviceId()

        if (serverUrl == null || deviceId == null) {
            return CommandResult.failure("Device not enrolled - missing server URL or device ID")
        }

        val success = telemetryCollector.sendTelemetrySuspend(serverUrl, deviceId)
        return if (success) {
            CommandResult.success()
        } else {
            CommandResult.failure("Failed to send telemetry to server")
        }
    }

    private suspend fun executeSyncApps(): CommandResult {
        val api = commandApiClient ?: return CommandResult.failure("Server URL not configured")

        val pm = packageManager
        val packages = pm.getInstalledPackages(0)
        Log.i(TAG, "Syncing ${packages.size} installed apps to server")

        val apps = packages.map { pkg ->
            InstalledApp(
                packageName = pkg.packageName,
                appName = pkg.applicationInfo?.loadLabel(pm)?.toString() ?: "",
                versionName = pkg.versionName ?: "",
                versionCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    pkg.longVersionCode
                } else {
                    @Suppress("DEPRECATION")
                    pkg.versionCode.toLong()
                },
                isSystemApp = ((pkg.applicationInfo?.flags ?: 0) and android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0,
                enabled = pkg.applicationInfo?.enabled ?: true
            )
        }

        return try {
            val success = api.postApps(AppInventory.toJson(apps))
            if (success) {
                Log.i(TAG, "App inventory synced: ${packages.size} apps")
                CommandResult.success()
            } else {
                CommandResult.failure("Server rejected the app inventory")
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.e(TAG, "Failed to sync apps", e)
            CommandResult.failure("Failed to sync apps: ${e.message}")
        }
    }

    private fun executeSyncPolicy(command: DeviceCommand): CommandResult {
        Log.i(TAG, "Syncing policy settings")

        // Only the fields the payload carries are changed (AM-09)
        val update = PolicyUpdate.parse(command.payload)

        val mdmPrefs = getSharedPreferences("mdm_settings", Context.MODE_PRIVATE)
        val edit = mdmPrefs.edit()
        update.silentMode?.let { edit.putBoolean("silent_mode", it) }
        update.kioskMode?.let { edit.putBoolean("kiosk_mode", it) } // legacy flag; SET_KIOSK is the real control
        if (update.updateWindowProvided) {
            val w = update.updateWindow
            if (w == null) edit.remove("update_window_start").remove("update_window_end")
            else edit.putInt("update_window_start", w.startMinute).putInt("update_window_end", w.endMinute)
        }
        edit.apply()

        update.silentMode?.let { silent ->
            val success = if (silent) deviceOwnerManager.enableSilentMode() else deviceOwnerManager.disableSilentMode()
            Log.i(TAG, "Silent mode ${if (silent) "enabled" else "disabled"}: $success")
        }

        // requiredApps is authoritative for the boot list: rebuild it so removed apps stop starting
        val required = update.requiredApps
        if (required != null) {
            val isInstalled = { pkg: String ->
                try { packageManager.getPackageInfo(pkg, 0); true } catch (e: PackageManager.NameNotFoundException) { false }
            }
            val kioskPkg = kioskController.config()?.packageName
            val map = BootAppsMerge.fromRequired(required, isInstalled).toMutableMap()
            // The kiosk target stays the foreground app, whatever the policy list says
            if (kioskPkg != null) {
                map.entries.removeAll { it.value }
                map[kioskPkg] = true
            }
            bootApps().replaceAll(map)
            Log.i(TAG, "Boot list rebuilt from policy: $map")

            val fg = required.lastOrNull { it.foreground && isInstalled(it.packageName) }
            if (fg != null && kioskPkg == null) launchAppWithRetry(fg.packageName, true)
        }

        return CommandResult.success()
    }

    private fun executeSetVolume(command: DeviceCommand): CommandResult {
        val level = command.payload["level"]?.jsonPrimitive?.content?.toIntOrNull()
            ?: return CommandResult.failure("Missing or invalid 'level' in payload")

        if (level !in 0..100) {
            return CommandResult.failure("Volume level must be between 0 and 100")
        }

        val streamName = command.payload["stream"]?.jsonPrimitive?.content ?: "music"

        val audioManager = getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager

        val streamType = when (streamName.lowercase()) {
            "music" -> android.media.AudioManager.STREAM_MUSIC
            "ring" -> android.media.AudioManager.STREAM_RING
            "alarm" -> android.media.AudioManager.STREAM_ALARM
            "notification" -> android.media.AudioManager.STREAM_NOTIFICATION
            "system" -> android.media.AudioManager.STREAM_SYSTEM
            "voice_call" -> android.media.AudioManager.STREAM_VOICE_CALL
            else -> return CommandResult.failure("Unknown stream type: $streamName")
        }

        val maxVolume = audioManager.getStreamMaxVolume(streamType)
        val scaledVolume = (level * maxVolume / 100).coerceIn(0, maxVolume)

        audioManager.setStreamVolume(streamType, scaledVolume, 0)
        Log.i(TAG, "Set volume: stream=$streamName level=$level% scaled=$scaledVolume/$maxVolume")

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
