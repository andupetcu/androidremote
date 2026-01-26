package com.androidremote.app

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.provider.Settings
import android.widget.Button
import android.widget.ImageView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.androidremote.app.api.PairingApiClient
import com.androidremote.app.controller.SessionController
import com.androidremote.app.controller.SessionState
import com.androidremote.app.databinding.ActivityMainBinding
import com.androidremote.app.service.RemoteSessionService
import com.androidremote.app.ui.PermissionHelper
import com.androidremote.app.ui.QrCodeGenerator
import com.androidremote.app.ui.ScreenState
import com.androidremote.app.ui.SessionStorage
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
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

    private lateinit var binding: ActivityMainBinding
    private lateinit var permissionHelper: PermissionHelper
    private lateinit var sessionStorage: SessionStorage
    private lateinit var pairingApiClient: PairingApiClient

    private var sessionController: SessionController? = null
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        permissionHelper = PermissionHelper(this)
        sessionStorage = SessionStorage.create(this)
        pairingApiClient = PairingApiClient(BuildConfig.PAIRING_SERVER_URL)

        setupClickListeners()
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
        pairingApiClient.close()
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
            permissionsView.findViewById<Button>(R.id.btnContinue)?.setOnClickListener {
                showScreen(ScreenState.READY)
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

        // Error screen
        binding.viewFlipper.getChildAt(ScreenState.ERROR.index).let { errorView ->
            errorView.findViewById<Button>(R.id.btnRetry)?.setOnClickListener {
                showScreen(ScreenState.READY)
            }
        }
    }

    private fun updatePermissionStatus() {
        val accessibilityEnabled = permissionHelper.isAccessibilityServiceEnabled()
        val notificationEnabled = permissionHelper.hasNotificationPermission()

        binding.viewFlipper.getChildAt(ScreenState.PERMISSIONS.index).let { permissionsView ->
            permissionsView.findViewById<ImageView>(R.id.checkAccessibility)?.setImageResource(
                if (accessibilityEnabled) android.R.drawable.checkbox_on_background
                else android.R.drawable.checkbox_off_background
            )
            permissionsView.findViewById<ImageView>(R.id.checkNotification)?.setImageResource(
                if (notificationEnabled) android.R.drawable.checkbox_on_background
                else android.R.drawable.checkbox_off_background
            )
            permissionsView.findViewById<Button>(R.id.btnContinue)?.isEnabled =
                accessibilityEnabled && notificationEnabled
        }
    }

    private fun checkInitialScreen() {
        when {
            !permissionHelper.hasAllRequiredPermissions() -> showScreen(ScreenState.PERMISSIONS)
            sessionController?.state?.value is SessionState.Connected -> showScreen(ScreenState.CONNECTED)
            else -> showScreen(ScreenState.READY)
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
                showError("Failed to start pairing: ${e.message}")
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
                        showError("Pairing code expired. Please try again.")
                        return
                    }
                    // "pending" - continue polling
                }
                delay(2000) // Poll every 2 seconds
            } catch (e: Exception) {
                showError("Connection error: ${e.message}")
                return
            }
        }
    }

    private fun connectToSession(serverUrl: String, sessionToken: String, deviceId: String) {
        lifecycleScope.launch {
            try {
                sessionController?.connect(serverUrl, sessionToken, deviceId)
            } catch (e: Exception) {
                showError("Failed to connect: ${e.message}")
            }
        }
    }

    private fun cancelPairing() {
        pairingJob?.cancel()
        showScreen(ScreenState.READY)
    }

    private fun disconnect() {
        lifecycleScope.launch {
            sessionController?.disconnect()
            durationJob?.cancel()
            sessionStorage.clear()
            currentDeviceId = null
            showScreen(ScreenState.READY)
        }
    }

    private fun showError(message: String) {
        binding.viewFlipper.getChildAt(ScreenState.ERROR.index).let { errorView ->
            errorView.findViewById<TextView>(R.id.txtErrorMessage)?.text = message
        }
        showScreen(ScreenState.ERROR)
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
                            showScreen(ScreenState.READY)
                        }
                    }
                    is SessionState.Error -> {
                        durationJob?.cancel()
                        showError(state.message)
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
