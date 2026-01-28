package com.androidremote.app

import android.Manifest
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.view.LayoutInflater
import android.widget.Button
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.androidremote.app.admin.DeviceOwnerReceiver
import com.androidremote.app.admin.DeviceOwnerManager
import com.androidremote.app.api.EnrollmentApiClient
import com.androidremote.app.api.EnrollmentException
import com.androidremote.app.api.EnrollmentErrorType
import com.androidremote.app.api.PairingApiClient
import com.androidremote.app.controller.SessionController
import com.androidremote.app.controller.SessionState
import com.androidremote.app.databinding.ActivityMainBinding
import com.androidremote.app.mdm.CommandPollingService
import com.androidremote.app.service.RemoteSessionService
import com.androidremote.app.ui.PermissionHelper
import com.androidremote.app.ui.QrCodeGenerator
import com.androidremote.app.ui.ScreenState
import com.androidremote.app.ui.SessionStorage
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

/**
 * Main entry point for the Android Remote app.
 *
 * Responsibilities:
 * - Permission wizard and onboarding
 * - Pairing flow initiation
 * - Session status display
 * - Start/stop remote session controls
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "MainActivity"
    }

    private lateinit var binding: ActivityMainBinding
    private lateinit var permissionHelper: PermissionHelper
    private lateinit var deviceOwnerManager: DeviceOwnerManager
    private lateinit var sessionStorage: SessionStorage
    private lateinit var pairingApiClient: PairingApiClient
    private lateinit var enrollmentApiClient: EnrollmentApiClient

    private var sessionController: SessionController? = null
    private var enrollmentJob: Job? = null
    private var serviceBound = false
    private var pairingJob: Job? = null
    private var durationJob: Job? = null
    private var sessionStartTime: Long = 0
    private var currentDeviceId: String? = null

    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            val localBinder = binder as RemoteSessionService.LocalBinder
            sessionController = localBinder.getController()
            serviceBound = true
            observeSessionState()
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            sessionController = null
            serviceBound = false
        }
    }

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { _ ->
        updatePermissionStatus()
    }

    private val locationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { _ ->
        updatePermissionStatus()
    }

    private val deviceAdminLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { _ ->
        updatePermissionStatus()
    }

    private val batteryOptimizationLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { _ ->
        updatePermissionStatus()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        permissionHelper = PermissionHelper(this)
        deviceOwnerManager = DeviceOwnerManager(this)
        sessionStorage = SessionStorage.create(this)

        // Initialize API clients with stored URL or default
        val serverUrl = getServerUrl()
        pairingApiClient = PairingApiClient(serverUrl)
        enrollmentApiClient = EnrollmentApiClient(serverUrl)
        Log.i(TAG, "Using server URL: $serverUrl")

        setupClickListeners()

        // Settings button click listener
        binding.btnSettings.setOnClickListener {
            showServerSettingsDialog()
        }

        // In Device Owner mode, auto-grant runtime permissions
        if (deviceOwnerManager.isDeviceOwner()) {
            Log.i(TAG, "Device Owner mode detected - auto-granting permissions")
            deviceOwnerManager.autoGrantPermissions()
            // Revoke location permissions to stop "Location can be accessed" notification
            deviceOwnerManager.revokeLocationPermissions()
            // Attempt battery optimization exemption
            deviceOwnerManager.exemptFromBatteryOptimization()
        }
    }

    /**
     * Get server URL from storage or fall back to BuildConfig default.
     */
    private fun getServerUrl(): String {
        return sessionStorage.getServerUrl() ?: BuildConfig.PAIRING_SERVER_URL
    }

    /**
     * Show dialog to configure server address and port.
     */
    private fun showServerSettingsDialog() {
        val dialogView = LayoutInflater.from(this).inflate(R.layout.dialog_server_settings, null)
        val etServerAddress = dialogView.findViewById<TextInputEditText>(R.id.etServerAddress)
        val etServerPort = dialogView.findViewById<TextInputEditText>(R.id.etServerPort)
        val tilServerAddress = dialogView.findViewById<TextInputLayout>(R.id.tilServerAddress)
        val tilServerPort = dialogView.findViewById<TextInputLayout>(R.id.tilServerPort)

        // Pre-fill with current values
        val currentUrl = getServerUrl()
        try {
            val url = java.net.URL(currentUrl)
            etServerAddress?.setText(url.host)
            val port = if (url.port != -1) url.port else if (url.protocol == "https") 443 else 80
            etServerPort?.setText(port.toString())
        } catch (e: Exception) {
            // Default values if parsing fails
            etServerAddress?.setText("")
            etServerPort?.setText("7899")
        }

        AlertDialog.Builder(this)
            .setTitle(R.string.server_settings)
            .setView(dialogView)
            .setPositiveButton(R.string.save) { dialog, _ ->
                val address = etServerAddress?.text?.toString()?.trim() ?: ""
                val portStr = etServerPort?.text?.toString()?.trim() ?: ""

                // Validate address
                if (address.isEmpty()) {
                    tilServerAddress?.error = getString(R.string.error_invalid_address)
                    return@setPositiveButton
                }

                // Validate port
                val port = portStr.toIntOrNull()
                if (port == null || port < 1 || port > 65535) {
                    tilServerPort?.error = getString(R.string.error_invalid_port)
                    return@setPositiveButton
                }

                // Build and save URL
                val newUrl = "http://$address:$port"
                sessionStorage.saveServerUrl(newUrl)

                // Reinitialize API clients
                pairingApiClient.close()
                enrollmentApiClient.close()
                pairingApiClient = PairingApiClient(newUrl)
                enrollmentApiClient = EnrollmentApiClient(newUrl)

                Log.i(TAG, "Server URL updated to: $newUrl")
                Toast.makeText(this, R.string.settings_saved, Toast.LENGTH_SHORT).show()
                dialog.dismiss()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    /**
     * Show confirmation dialog to reset configuration and allow re-enrollment.
     */
    private fun showResetConfigDialog() {
        AlertDialog.Builder(this)
            .setTitle(R.string.reset_config_title)
            .setMessage(R.string.reset_config_message)
            .setPositiveButton(R.string.reset) { _, _ ->
                resetConfiguration()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    /**
     * Clear all stored configuration and enrollment data, then navigate to enrollment screen.
     * Note: Device Owner status is preserved - use ADB to remove if needed.
     */
    private fun resetConfiguration() {
        // Stop the command polling service
        CommandPollingService.stopService(this)

        // NOTE: We intentionally do NOT clear Device Owner status here.
        // Device Owner is a system-level privilege set via ADB and should persist.
        // To remove Device Owner, use: adb shell dpm remove-active-admin com.androidremote.app/.admin.DeviceOwnerReceiver

        // Clear all stored data (device ID, session token, enrollment state, server URL)
        sessionStorage.clear()

        // Reinitialize API clients with default URL (clears any stored /ws suffix)
        val defaultUrl = BuildConfig.PAIRING_SERVER_URL
        pairingApiClient.close()
        enrollmentApiClient.close()
        pairingApiClient = PairingApiClient(defaultUrl)
        enrollmentApiClient = EnrollmentApiClient(defaultUrl)
        Log.i(TAG, "API clients reinitialized with URL: $defaultUrl")

        Log.i(TAG, "Configuration reset - enrollment data cleared, Device Owner preserved")
        Toast.makeText(this, R.string.config_reset_success, Toast.LENGTH_SHORT).show()

        // Navigate to enrollment screen
        showScreen(ScreenState.ENROLLMENT)
    }

    override fun onStart() {
        super.onStart()
        bindService(
            Intent(this, RemoteSessionService::class.java),
            serviceConnection,
            Context.BIND_AUTO_CREATE
        )
    }

    override fun onResume() {
        super.onResume()
        updatePermissionStatus()
        // Always check which screen to show - checkInitialScreen() has the logic
        // to skip permissions if setup is complete and device is enrolled.
        // This ensures the app navigates correctly after reboot.
        checkInitialScreen()
    }

    override fun onStop() {
        super.onStop()
        if (serviceBound) {
            unbindService(serviceConnection)
            serviceBound = false
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        pairingJob?.cancel()
        durationJob?.cancel()
        enrollmentJob?.cancel()
        pairingApiClient.close()
        enrollmentApiClient.close()
    }

    private fun setupClickListeners() {
        // Permissions screen
        binding.viewFlipper.getChildAt(ScreenState.PERMISSIONS.index).let { permissionsView ->
            permissionsView.findViewById<android.view.View>(R.id.cardAccessibility)?.setOnClickListener {
                openAccessibilitySettings()
            }
            permissionsView.findViewById<android.view.View>(R.id.cardNotification)?.setOnClickListener {
                requestNotificationPermission()
            }
            permissionsView.findViewById<android.view.View>(R.id.cardBattery)?.setOnClickListener {
                requestBatteryOptimizationExemption()
            }
            permissionsView.findViewById<android.view.View>(R.id.cardDeviceAdmin)?.setOnClickListener {
                requestDeviceAdmin()
            }
            permissionsView.findViewById<android.view.View>(R.id.cardLocation)?.setOnClickListener {
                requestLocationPermission()
            }
            permissionsView.findViewById<Button>(R.id.btnContinue)?.setOnClickListener {
                // Mark initial setup as complete so we don't ask again
                sessionStorage.setInitialSetupComplete(true)

                // Go to enrollment if not enrolled, otherwise managed
                if (sessionStorage.isEnrolled()) {
                    CommandPollingService.startService(this, pollIntervalMs = 5000L)
                    showScreen(ScreenState.MANAGED)
                    updateManagedScreenStatus()
                } else {
                    showScreen(ScreenState.ENROLLMENT)
                }
            }
        }

        // Enrollment screen
        binding.viewFlipper.getChildAt(ScreenState.ENROLLMENT.index).let { enrollView ->
            val editToken = enrollView.findViewById<android.widget.EditText>(R.id.editToken)
            val btnEnroll = enrollView.findViewById<Button>(R.id.btnEnroll)

            // Enable button only when token is 8 characters
            editToken?.addTextChangedListener(object : android.text.TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
                override fun afterTextChanged(s: android.text.Editable?) {
                    btnEnroll?.isEnabled = (s?.length ?: 0) == 8
                    // Clear error when user types
                    enrollView.findViewById<TextView>(R.id.txtEnrollmentError)?.visibility =
                        android.view.View.GONE
                }
            })

            btnEnroll?.setOnClickListener {
                val token = editToken?.text?.toString()?.uppercase() ?: return@setOnClickListener
                startEnrollment(token)
            }
        }

        // Ready screen
        binding.viewFlipper.getChildAt(ScreenState.READY.index).let { readyView ->
            readyView.findViewById<Button>(R.id.btnStartPairing)?.setOnClickListener {
                startPairing()
            }
        }

        // Pairing screen
        binding.viewFlipper.getChildAt(ScreenState.PAIRING.index).let { pairingView ->
            pairingView.findViewById<Button>(R.id.btnCancelPairing)?.setOnClickListener {
                cancelPairing()
            }
        }

        // Connected screen
        binding.viewFlipper.getChildAt(ScreenState.CONNECTED.index).let { connectedView ->
            connectedView.findViewById<Button>(R.id.btnDisconnect)?.setOnClickListener {
                disconnect()
            }
        }
        // Managed screen buttons
        binding.viewFlipper.getChildAt(ScreenState.MANAGED.index).let { managedView ->
            managedView.findViewById<Button>(R.id.btnResetConfig)?.setOnClickListener {
                showResetConfigDialog()
            }
            managedView.findViewById<Button>(R.id.btnSyncNow)?.setOnClickListener {
                triggerManualSync()
            }
        }
    }

    /**
     * Update the Managed screen UI with current connection status.
     */
    private fun updateManagedScreenStatus() {
        binding.viewFlipper.getChildAt(ScreenState.MANAGED.index).let { managedView ->
            val imgStatus = managedView.findViewById<ImageView>(R.id.imgConnectionStatus)
            val txtStatus = managedView.findViewById<TextView>(R.id.txtConnectionStatus)
            val txtLastSync = managedView.findViewById<TextView>(R.id.txtLastSync)
            val txtServerUrl = managedView.findViewById<TextView>(R.id.txtServerUrl)
            val txtDeviceId = managedView.findViewById<TextView>(R.id.txtDeviceId)
            val txtError = managedView.findViewById<TextView>(R.id.txtErrorMessage)

            // Server info
            txtServerUrl?.text = sessionStorage.getServerUrl() ?: "Not configured"
            txtDeviceId?.text = sessionStorage.getDeviceId() ?: "Not enrolled"

            // Connection status
            val status = sessionStorage.getConnectionStatus()
            val lastSyncTime = sessionStorage.getLastSyncTime()
            val lastSyncError = sessionStorage.getLastSyncError()

            when (status) {
                SessionStorage.ConnectionStatus.ONLINE -> {
                    imgStatus?.setImageResource(android.R.drawable.presence_online)
                    txtStatus?.text = "Online"
                    txtStatus?.setTextColor(getColor(android.R.color.holo_green_dark))
                    txtError?.visibility = android.view.View.GONE
                }
                SessionStorage.ConnectionStatus.OFFLINE -> {
                    imgStatus?.setImageResource(android.R.drawable.presence_offline)
                    txtStatus?.text = "Offline"
                    txtStatus?.setTextColor(getColor(android.R.color.darker_gray))
                    txtError?.visibility = android.view.View.GONE
                }
                SessionStorage.ConnectionStatus.ERROR -> {
                    imgStatus?.setImageResource(android.R.drawable.presence_busy)
                    txtStatus?.text = "Connection Error"
                    txtStatus?.setTextColor(getColor(android.R.color.holo_red_dark))
                    if (!lastSyncError.isNullOrEmpty()) {
                        txtError?.text = lastSyncError
                        txtError?.visibility = android.view.View.VISIBLE
                    }
                }
                SessionStorage.ConnectionStatus.CONNECTING -> {
                    imgStatus?.setImageResource(android.R.drawable.presence_away)
                    txtStatus?.text = "Connecting..."
                    txtStatus?.setTextColor(getColor(android.R.color.holo_orange_dark))
                    txtError?.visibility = android.view.View.GONE
                }
            }

            // Last sync time
            if (lastSyncTime > 0) {
                val elapsed = System.currentTimeMillis() - lastSyncTime
                val timeAgo = when {
                    elapsed < 60_000 -> "just now"
                    elapsed < 3600_000 -> "${elapsed / 60_000} min ago"
                    elapsed < 86400_000 -> "${elapsed / 3600_000} hours ago"
                    else -> "${elapsed / 86400_000} days ago"
                }
                txtLastSync?.text = "Last sync: $timeAgo"
            } else {
                txtLastSync?.text = "Last sync: Never"
            }
        }
    }

    /**
     * Trigger a manual telemetry sync.
     */
    private fun triggerManualSync() {
        val serverUrl = sessionStorage.getServerUrl()
        val deviceId = sessionStorage.getDeviceId()

        if (serverUrl == null || deviceId == null) {
            Toast.makeText(this, "Not enrolled - cannot sync", Toast.LENGTH_SHORT).show()
            return
        }

        lifecycleScope.launch {
            // Show syncing state
            sessionStorage.setConnectionStatus(SessionStorage.ConnectionStatus.CONNECTING)
            updateManagedScreenStatus()

            val httpUrl = serverUrl
                .replace("wss://", "https://")
                .replace("ws://", "http://")
                .removeSuffix("/ws")

            try {
                val collector = com.androidremote.app.mdm.TelemetryCollector(this@MainActivity)
                val success = withContext(Dispatchers.IO) {
                    collector.sendTelemetry(httpUrl, deviceId)
                }

                if (success) {
                    Toast.makeText(this@MainActivity, "Sync successful", Toast.LENGTH_SHORT).show()
                } else {
                    Toast.makeText(this@MainActivity, "Sync failed", Toast.LENGTH_SHORT).show()
                }
            } catch (e: Exception) {
                sessionStorage.updateSyncStatus(false, e.message)
                Toast.makeText(this@MainActivity, "Sync error: ${e.message}", Toast.LENGTH_SHORT).show()
            }

            updateManagedScreenStatus()
        }
    }

    private fun updatePermissionStatus() {
        val accessibilityEnabled = permissionHelper.isAccessibilityServiceEnabled()
        val notificationEnabled = permissionHelper.hasNotificationPermission()
        val batteryOptimizationDisabled = permissionHelper.isBatteryOptimizationDisabled()
        val locationEnabled = permissionHelper.hasLocationPermission()
        val isDeviceOwner = deviceOwnerManager.isDeviceOwner()
        val isDeviceAdmin = deviceOwnerManager.isDeviceAdmin()

        binding.viewFlipper.getChildAt(ScreenState.PERMISSIONS.index).let { permissionsView ->
            permissionsView.findViewById<ImageView>(R.id.checkAccessibility)?.setImageResource(
                if (accessibilityEnabled) android.R.drawable.checkbox_on_background
                else android.R.drawable.checkbox_off_background
            )
            permissionsView.findViewById<ImageView>(R.id.checkNotification)?.setImageResource(
                if (notificationEnabled) android.R.drawable.checkbox_on_background
                else android.R.drawable.checkbox_off_background
            )
            permissionsView.findViewById<ImageView>(R.id.checkBattery)?.setImageResource(
                if (batteryOptimizationDisabled) android.R.drawable.checkbox_on_background
                else android.R.drawable.checkbox_off_background
            )
            permissionsView.findViewById<ImageView>(R.id.checkDeviceAdmin)?.setImageResource(
                if (isDeviceOwner || isDeviceAdmin) android.R.drawable.checkbox_on_background
                else android.R.drawable.checkbox_off_background
            )
            permissionsView.findViewById<ImageView>(R.id.checkLocation)?.setImageResource(
                if (locationEnabled) android.R.drawable.checkbox_on_background
                else android.R.drawable.checkbox_off_background
            )

            // In Device Owner mode, hide some permission cards (auto-granted)
            if (isDeviceOwner) {
                permissionsView.findViewById<android.view.View>(R.id.cardNotification)?.visibility =
                    android.view.View.GONE
                permissionsView.findViewById<android.view.View>(R.id.cardDeviceAdmin)?.visibility =
                    android.view.View.GONE
                permissionsView.findViewById<android.view.View>(R.id.cardLocation)?.visibility =
                    android.view.View.GONE
                Log.d(TAG, "Device Owner mode: permissions auto-granted, hiding cards")
            }

            // Continue button enabled when required permissions are met
            // Required: notification + battery optimization
            // Optional but recommended: accessibility, device admin, location
            val canContinue = if (isDeviceOwner) {
                batteryOptimizationDisabled // Device Owner auto-grants most permissions
            } else {
                notificationEnabled && batteryOptimizationDisabled
            }
            permissionsView.findViewById<Button>(R.id.btnContinue)?.isEnabled = canContinue
        }
    }

    private fun checkInitialScreen() {
        val hasPermissions = permissionHelper.hasAllRequiredPermissions()
        val isEnrolled = sessionStorage.isEnrolled()
        val isConnected = sessionController?.state?.value is SessionState.Connected
        val isDeviceOwner = deviceOwnerManager.isDeviceOwner()
        val setupComplete = sessionStorage.isInitialSetupComplete()
        val batteryOptDisabled = permissionHelper.isBatteryOptimizationDisabled()
        val accessibilityEnabled = permissionHelper.isAccessibilityServiceEnabled()

        Log.d(TAG, "checkInitialScreen: hasPermissions=$hasPermissions, isEnrolled=$isEnrolled, isConnected=$isConnected, setupComplete=$setupComplete, isDeviceOwner=$isDeviceOwner, batteryOpt=$batteryOptDisabled, accessibility=$accessibilityEnabled")

        // In Device Owner mode, we can skip permissions if:
        // 1. Battery optimization is disabled (required for background operation)
        // 2. Accessibility is enabled (required for input injection)
        // Runtime permissions are auto-granted in Device Owner mode
        val deviceOwnerReady = isDeviceOwner && batteryOptDisabled && accessibilityEnabled

        // Skip permissions screen if:
        // 1. Device Owner mode with all required settings enabled
        // 2. Setup already completed and enrolled
        // 3. All required permissions are granted
        val skipPermissions = deviceOwnerReady || (setupComplete && isEnrolled) || hasPermissions

        when {
            !skipPermissions -> {
                Log.d(TAG, "Showing PERMISSIONS screen")
                showScreen(ScreenState.PERMISSIONS)
            }
            !isEnrolled -> {
                Log.d(TAG, "Showing ENROLLMENT screen")
                showScreen(ScreenState.ENROLLMENT)
            }
            isConnected -> {
                Log.d(TAG, "Showing CONNECTED screen")
                showScreen(ScreenState.CONNECTED)
            }
            isEnrolled -> {
                // Device is enrolled - start polling and show managed state
                Log.d(TAG, "Showing MANAGED screen, starting CommandPollingService")
                // Mark setup complete since we're past permissions
                if (!setupComplete) {
                    sessionStorage.setInitialSetupComplete(true)
                }
                CommandPollingService.startService(this, pollIntervalMs = 5000L)
                showScreen(ScreenState.MANAGED)
                updateManagedScreenStatus()
            }
            else -> {
                // This should never happen logically, but log it if it does
                Log.w(TAG, "Unexpected state: showing READY screen")
                showScreen(ScreenState.READY)
            }
        }
    }

    private fun showScreen(screen: ScreenState) {
        binding.viewFlipper.displayedChild = screen.index
    }

    private fun openAccessibilitySettings() {
        startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    @Suppress("BatteryLife")
    private fun requestBatteryOptimizationExemption() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
            if (!powerManager.isIgnoringBatteryOptimizations(packageName)) {
                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:$packageName")
                }
                batteryOptimizationLauncher.launch(intent)
            }
        }
    }

    private fun requestDeviceAdmin() {
        if (!deviceOwnerManager.isDeviceAdmin()) {
            val componentName = DeviceOwnerReceiver.getComponentName(this)
            val intent = Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN).apply {
                putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, componentName)
                putExtra(
                    DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                    "Device Administrator access allows the app to lock, wipe, and manage your device remotely."
                )
            }
            deviceAdminLauncher.launch(intent)
        }
    }

    private fun requestLocationPermission() {
        val permissions = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        )
        // Background location requires separate request on Android 10+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // Only request background location if foreground is already granted
            if (permissionHelper.hasLocationPermission()) {
                locationPermissionLauncher.launch(arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION))
                return
            }
        }
        locationPermissionLauncher.launch(permissions.toTypedArray())
    }

    private fun startPairing() {
        showScreen(ScreenState.PAIRING)

        pairingJob = lifecycleScope.launch {
            try {
                val deviceName = Build.MODEL
                val deviceModel = "${Build.MANUFACTURER} ${Build.MODEL}"
                val response = pairingApiClient.initiatePairing(deviceName, deviceModel)

                // Display QR code and pairing code
                val qrBitmap = QrCodeGenerator.generate(response.qrCodeData, 480)
                binding.viewFlipper.getChildAt(ScreenState.PAIRING.index).let { pairingView ->
                    pairingView.findViewById<ImageView>(R.id.imgQrCode)?.setImageBitmap(qrBitmap)
                    pairingView.findViewById<TextView>(R.id.txtPairingCode)?.text = response.pairingCode
                }

                // Save device ID for status polling and connection
                currentDeviceId = response.deviceId
                sessionStorage.saveDeviceId(response.deviceId)

                // Poll for pairing completion
                pollPairingStatus(response.deviceId)
            } catch (e: Exception) {
                Toast.makeText(this@MainActivity, "Failed to start pairing: ${e.message}", Toast.LENGTH_LONG).show()
                showScreen(ScreenState.READY)
            }
        }
    }

    private suspend fun pollPairingStatus(deviceId: String) {
        while (lifecycleScope.coroutineContext.isActive) {
            try {
                val status = pairingApiClient.getStatus(deviceId)
                when (status.status) {
                    "completed" -> {
                        status.sessionToken?.let { token ->
                            status.serverUrl?.let { url ->
                                sessionStorage.saveSessionToken(token)
                                sessionStorage.saveServerUrl(url)
                                connectToSession(url, token, deviceId)
                                return
                            }
                        }
                    }
                    "expired" -> {
                        withContext(Dispatchers.Main) {
                            Toast.makeText(this@MainActivity, "Pairing code expired. Please try again.", Toast.LENGTH_LONG).show()
                            showScreen(ScreenState.READY)
                        }
                        return
                    }
                    // "pending" - continue polling
                }
                delay(2000) // Poll every 2 seconds
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    Toast.makeText(this@MainActivity, "Connection error: ${e.message}", Toast.LENGTH_LONG).show()
                    showScreen(ScreenState.READY)
                }
                return
            }
        }
    }

    private fun connectToSession(serverUrl: String, sessionToken: String, deviceId: String) {
        lifecycleScope.launch {
            try {
                sessionController?.connect(serverUrl, sessionToken, deviceId)
            } catch (e: Exception) {
                Toast.makeText(this@MainActivity, "Failed to connect: ${e.message}", Toast.LENGTH_LONG).show()
                showScreen(ScreenState.READY)
            }
        }
    }

    private fun cancelPairing() {
        pairingJob?.cancel()
        showScreen(ScreenState.READY)
    }

    private fun startEnrollment(token: String) {
        val enrollView = binding.viewFlipper.getChildAt(ScreenState.ENROLLMENT.index)
        val btnEnroll = enrollView.findViewById<Button>(R.id.btnEnroll)
        val progress = enrollView.findViewById<android.widget.ProgressBar>(R.id.enrollmentProgress)
        val errorText = enrollView.findViewById<TextView>(R.id.txtEnrollmentError)

        // Show loading state
        btnEnroll?.isEnabled = false
        progress?.visibility = android.view.View.VISIBLE
        errorText?.visibility = android.view.View.GONE

        enrollmentJob = lifecycleScope.launch {
            try {
                val deviceName = Build.MODEL
                val deviceModel = "${Build.MANUFACTURER} ${Build.MODEL}"
                val androidVersion = Build.VERSION.RELEASE

                val response = enrollmentApiClient.enrollDevice(
                    token = token,
                    deviceName = deviceName,
                    deviceModel = deviceModel,
                    androidVersion = androidVersion
                )

                // Save enrollment data
                sessionStorage.saveDeviceId(response.deviceId)
                sessionStorage.saveServerUrl(response.serverUrl)
                sessionStorage.saveSessionToken(response.sessionToken)
                sessionStorage.setEnrolled(true)

                Log.i(TAG, "Device enrolled successfully: ${response.deviceId}")

                // Start command polling service for MDM with fast polling
                // Use 5 second intervals for responsive remote control
                CommandPollingService.startService(this@MainActivity, pollIntervalMs = 5000L)
                Log.i(TAG, "Started CommandPollingService with 5s interval")

                // Show managed screen - waiting for commands from server
                showScreen(ScreenState.MANAGED)

            } catch (e: EnrollmentException) {
                Log.w(TAG, "Enrollment failed: ${e.message}", e)
                val errorMessage = when (e.errorType) {
                    EnrollmentErrorType.INVALID_TOKEN -> "Invalid or expired token. Please check with your administrator."
                    EnrollmentErrorType.VALIDATION -> e.message
                    EnrollmentErrorType.NETWORK -> "Network error. Please check your connection."
                    EnrollmentErrorType.SERVER_ERROR -> "Server error. Please try again later."
                }
                showEnrollmentError(errorMessage)
            } catch (e: Exception) {
                Log.e(TAG, "Enrollment failed", e)
                showEnrollmentError("Connection error: ${e.message}")
            } finally {
                // Hide loading state
                btnEnroll?.isEnabled = true
                progress?.visibility = android.view.View.GONE
            }
        }
    }

    private fun showEnrollmentError(message: String) {
        val enrollView = binding.viewFlipper.getChildAt(ScreenState.ENROLLMENT.index)
        val errorText = enrollView.findViewById<TextView>(R.id.txtEnrollmentError)
        errorText?.text = message
        errorText?.visibility = android.view.View.VISIBLE
    }

    private fun disconnect() {
        lifecycleScope.launch {
            sessionController?.disconnect()
            durationJob?.cancel()
            sessionStorage.clearSession()  // Keep enrollment, just clear session token
            currentDeviceId = null
            // Go to MANAGED if enrolled, otherwise READY
            if (sessionStorage.isEnrolled()) {
                showScreen(ScreenState.MANAGED)
            } else {
                showScreen(ScreenState.READY)
            }
        }
    }

    private fun observeSessionState() {
        lifecycleScope.launch {
            sessionController?.state?.collect { state ->
                when (state) {
                    is SessionState.Connected -> {
                        sessionStartTime = System.currentTimeMillis()
                        startDurationTimer()
                        showScreen(ScreenState.CONNECTED)
                    }
                    is SessionState.Disconnected -> {
                        durationJob?.cancel()
                        if (binding.viewFlipper.displayedChild == ScreenState.CONNECTED.index) {
                            // Go back to MANAGED if enrolled, otherwise READY
                            if (sessionStorage.isEnrolled()) {
                                showScreen(ScreenState.MANAGED)
                            } else {
                                showScreen(ScreenState.READY)
                            }
                        }
                    }
                    is SessionState.Error -> {
                        durationJob?.cancel()
                        // Show toast instead of error screen, navigate to appropriate screen
                        Toast.makeText(this@MainActivity, state.message, Toast.LENGTH_SHORT).show()
                        if (sessionStorage.isEnrolled()) {
                            showScreen(ScreenState.MANAGED)
                        } else {
                            showScreen(ScreenState.READY)
                        }
                    }
                    is SessionState.Reconnecting -> {
                        binding.viewFlipper.getChildAt(ScreenState.CONNECTED.index).let { connectedView ->
                            connectedView.findViewById<TextView>(R.id.txtDeviceInfo)?.text =
                                "Reconnecting (${state.attempt}/${state.maxAttempts})..."
                        }
                    }
                    is SessionState.Connecting -> {
                        // Keep current screen during connection
                    }
                }
            }
        }
    }

    private fun startDurationTimer() {
        durationJob?.cancel()
        durationJob = lifecycleScope.launch {
            while (isActive) {
                val elapsed = System.currentTimeMillis() - sessionStartTime
                val hours = TimeUnit.MILLISECONDS.toHours(elapsed)
                val minutes = TimeUnit.MILLISECONDS.toMinutes(elapsed) % 60
                val seconds = TimeUnit.MILLISECONDS.toSeconds(elapsed) % 60
                val durationText = String.format("Duration: %02d:%02d:%02d", hours, minutes, seconds)

                binding.viewFlipper.getChildAt(ScreenState.CONNECTED.index).let { connectedView ->
                    connectedView.findViewById<TextView>(R.id.txtSessionDuration)?.text = durationText
                }
                delay(1000)
            }
        }
    }
}
