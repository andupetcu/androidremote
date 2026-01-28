package com.androidremote.app.controller

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.util.Log
import com.androidremote.app.admin.DeviceOwnerManager
import com.androidremote.transport.AppInfo
import com.androidremote.transport.CommandResponseData
import com.androidremote.transport.RemoteCommand

/**
 * Handler for MDM (Mobile Device Management) commands.
 *
 * Provides functionality for:
 * - Device status queries
 * - Device lock/reboot/wipe
 * - App installation and uninstallation
 */
class MdmHandler(private val context: Context) {

    companion object {
        private const val TAG = "MdmHandler"
    }

    private val deviceOwnerManager: DeviceOwnerManager by lazy {
        DeviceOwnerManager(context)
    }

    /**
     * Get comprehensive device information.
     */
    fun handleGetDeviceInfo(): MdmCommandResult {
        return try {
            val deviceInfo = CommandResponseData.DeviceInfo(
                deviceName = Build.MODEL,
                model = Build.MODEL,
                manufacturer = Build.MANUFACTURER,
                androidVersion = Build.VERSION.RELEASE,
                sdkVersion = Build.VERSION.SDK_INT,
                batteryLevel = getBatteryLevel(),
                isCharging = isCharging(),
                wifiConnected = isWifiConnected(),
                freeStorageBytes = getFreeStorage(),
                totalStorageBytes = getTotalStorage(),
                isDeviceOwner = deviceOwnerManager.isDeviceOwner(),
                isDeviceAdmin = deviceOwnerManager.isDeviceAdmin()
            )
            MdmCommandResult.successWithData(deviceInfo)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to get device info", e)
            MdmCommandResult.error("Failed to get device info: ${e.message}")
        }
    }

    /**
     * Lock the device screen.
     */
    fun handleLockDevice(): MdmCommandResult {
        return try {
            if (!deviceOwnerManager.hasMdmPrivileges()) {
                return MdmCommandResult.error("Device lock requires Device Admin privileges")
            }
            deviceOwnerManager.lockDevice()
            MdmCommandResult.success()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to lock device", e)
            MdmCommandResult.error("Failed to lock device: ${e.message}")
        }
    }

    /**
     * Reboot the device.
     */
    fun handleRebootDevice(): MdmCommandResult {
        return try {
            if (!deviceOwnerManager.isDeviceOwner()) {
                return MdmCommandResult.error("Device reboot requires Device Owner privileges")
            }
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
                return MdmCommandResult.error("Device reboot requires Android 7.0+")
            }
            deviceOwnerManager.rebootDevice()
            MdmCommandResult.success()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to reboot device", e)
            MdmCommandResult.error("Failed to reboot device: ${e.message}")
        }
    }

    /**
     * Factory reset the device. USE WITH EXTREME CAUTION.
     */
    fun handleWipeDevice(cmd: RemoteCommand.WipeDevice): MdmCommandResult {
        return try {
            if (!deviceOwnerManager.isDeviceOwner()) {
                return MdmCommandResult.error("Device wipe requires Device Owner privileges")
            }

            Log.w(TAG, "INITIATING DEVICE WIPE - wipeExternalStorage=${cmd.wipeExternalStorage}")

            val flags = if (cmd.wipeExternalStorage) {
                android.app.admin.DevicePolicyManager.WIPE_EXTERNAL_STORAGE
            } else {
                0
            }

            deviceOwnerManager.wipeDevice(flags)
            MdmCommandResult.success()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to wipe device", e)
            MdmCommandResult.error("Failed to wipe device: ${e.message}")
        }
    }

    /**
     * List installed applications.
     */
    fun handleListApps(cmd: RemoteCommand.ListApps): MdmCommandResult {
        return try {
            val packageManager = context.packageManager
            val packages = packageManager.getInstalledPackages(0)

            val apps = packages
                .filter { pkg ->
                    if (cmd.includeSystemApps) {
                        true
                    } else {
                        // Filter out system apps
                        (pkg.applicationInfo?.flags?.and(ApplicationInfo.FLAG_SYSTEM) ?: 0) == 0
                    }
                }
                .map { pkg ->
                    val appInfo = pkg.applicationInfo
                    AppInfo(
                        packageName = pkg.packageName,
                        appName = appInfo?.loadLabel(packageManager)?.toString() ?: pkg.packageName,
                        versionName = pkg.versionName,
                        versionCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                            pkg.longVersionCode
                        } else {
                            @Suppress("DEPRECATION")
                            pkg.versionCode.toLong()
                        },
                        isSystemApp = (appInfo?.flags?.and(ApplicationInfo.FLAG_SYSTEM) ?: 0) != 0
                    )
                }
                .sortedBy { it.appName.lowercase() }

            MdmCommandResult.successWithData(CommandResponseData.AppList(apps))
        } catch (e: Exception) {
            Log.e(TAG, "Failed to list apps", e)
            MdmCommandResult.error("Failed to list apps: ${e.message}")
        }
    }

    /**
     * Install an app from a URL.
     * Note: Actual download and installation is complex - this provides the framework.
     */
    fun handleInstallApp(cmd: RemoteCommand.InstallApp): MdmCommandResult {
        return try {
            if (!deviceOwnerManager.isDeviceOwner()) {
                return MdmCommandResult.error("App installation requires Device Owner privileges")
            }

            if (!deviceOwnerManager.canInstallPackagesSilently()) {
                return MdmCommandResult.error("Silent app installation requires Android 9.0+ in Device Owner mode")
            }

            // TODO: Implement actual APK download and installation
            // This would involve:
            // 1. Download APK from cmd.apkUrl to a temp file
            // 2. Use PackageInstaller API with session
            // 3. In Device Owner mode, installation proceeds without user prompt

            Log.i(TAG, "Install app requested: ${cmd.packageName} from ${cmd.apkUrl}")
            MdmCommandResult.error("App installation not yet implemented")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to install app", e)
            MdmCommandResult.error("Failed to install app: ${e.message}")
        }
    }

    /**
     * Uninstall an app by package name.
     */
    fun handleUninstallApp(cmd: RemoteCommand.UninstallApp): MdmCommandResult {
        return try {
            if (!deviceOwnerManager.isDeviceOwner()) {
                return MdmCommandResult.error("App uninstallation requires Device Owner privileges")
            }

            // TODO: Implement actual uninstallation
            // This would use PackageInstaller.uninstall() API
            // In Device Owner mode, uninstallation proceeds without user prompt

            Log.i(TAG, "Uninstall app requested: ${cmd.packageName}")
            MdmCommandResult.error("App uninstallation not yet implemented")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to uninstall app", e)
            MdmCommandResult.error("Failed to uninstall app: ${e.message}")
        }
    }

    // ==================== Helper Methods ====================

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

    private fun isWifiConnected(): Boolean {
        val connectivityManager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = connectivityManager.activeNetwork ?: return false
        val capabilities = connectivityManager.getNetworkCapabilities(network) ?: return false
        return capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
    }

    private fun getFreeStorage(): Long {
        val stat = StatFs(Environment.getDataDirectory().path)
        return stat.availableBytes
    }

    private fun getTotalStorage(): Long {
        val stat = StatFs(Environment.getDataDirectory().path)
        return stat.totalBytes
    }
}

/**
 * Result of an MDM command execution.
 */
sealed class MdmCommandResult {
    abstract val success: Boolean
    abstract val errorMessage: String?
    abstract val data: CommandResponseData?

    data class Success(
        override val data: CommandResponseData? = null
    ) : MdmCommandResult() {
        override val success: Boolean = true
        override val errorMessage: String? = null
    }

    data class Error(
        override val errorMessage: String
    ) : MdmCommandResult() {
        override val success: Boolean = false
        override val data: CommandResponseData? = null
    }

    companion object {
        fun success(): MdmCommandResult = Success()
        fun successWithData(data: CommandResponseData): MdmCommandResult = Success(data)
        fun error(message: String): MdmCommandResult = Error(message)
    }
}
