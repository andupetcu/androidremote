package com.androidremote.app.kiosk

import android.app.ActivityOptions
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.app.admin.DevicePolicyManager
import android.util.Log
import com.androidremote.app.admin.DeviceOwnerManager
import com.androidremote.app.mdm.CommandResult
import kotlinx.serialization.json.JsonObject

/**
 * Applies SET_KIOSK and keeps the target in front. The decisions live in [KioskPolicy] and
 * [KioskWatchdog]; this class only makes the Android calls.
 *
 * The kiosk record lives in device-protected storage so it can be read on LOCKED_BOOT_COMPLETED.
 */
class KioskController(private val context: Context, private val owner: DeviceOwnerManager) {
    private val state = context.createDeviceProtectedStorageContext()
        .getSharedPreferences("kiosk_state", Context.MODE_PRIVATE)
    private val bootApps get() = BootApps(context.getSharedPreferences(BootApps.PREFS, Context.MODE_PRIVATE))
    @Volatile private var lastRelaunchMs: Long? = null

    fun config(): KioskConfig? {
        val pkg = state.getString("package", null) ?: return null
        return KioskConfig(pkg, true, state.getBoolean("lock_task", false))
    }

    /** Package the watchdog keeps in front: the kiosk target, else the boot foreground app. */
    fun target(): String? = KioskWatchdog.targetOf(config()?.packageName, runCatching { bootApps.foreground() }.getOrNull())

    fun setKiosk(payload: JsonObject): CommandResult {
        if (!owner.isDeviceOwner()) return CommandResult.failure("SET_KIOSK requires Device Owner privileges")
        val config = when (val p = KioskPolicy.parse(payload)) {
            is KioskParse.Ok -> p.config
            is KioskParse.Invalid -> return CommandResult.failure(p.reason)
        }
        val plan = KioskPolicy.plan(config, context.packageName)
        val dpm = owner.policyManager
        val admin = owner.adminComponent
        val previous = state.getString("package", null)
        try {
            dpm.setLockTaskPackages(admin, plan.lockTaskPackages.toTypedArray())
            if (plan.launchInLockTask) dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_NONE)

            // Drop any HOME preference we set earlier, then set the new one
            listOfNotNull(previous, config.packageName).distinct().forEach { dpm.clearPackagePersistentPreferredActivities(admin, it) }
            plan.homeReplacementPackage?.let { pkg ->
                val home = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).setPackage(pkg)
                val info = context.packageManager.queryIntentActivities(home, 0).firstOrNull()?.activityInfo
                    ?: return CommandResult.failure("$pkg has no HOME activity; use lockTask=true instead")
                val filter = IntentFilter(Intent.ACTION_MAIN).apply {
                    addCategory(Intent.CATEGORY_HOME); addCategory(Intent.CATEGORY_DEFAULT)
                }
                dpm.addPersistentPreferredActivity(admin, filter, ComponentName(info.packageName, info.name))
            }
            dpm.setKeyguardDisabled(admin, plan.keyguardDisabled)
            dpm.setStatusBarDisabled(admin, plan.statusBarDisabled)
        } catch (e: SecurityException) {
            Log.w(TAG, "Kiosk policy refused", e)
            return CommandResult.failure("Kiosk policy refused: ${e.message}")
        }

        plan.clearBootPackage?.let { bootApps.remove(it) }
        plan.bootForeground?.let { bootApps.save(it, true) }
        if (config.enabled) {
            state.edit().putString("package", config.packageName).putBoolean("lock_task", config.lockTask).apply()
            launch(config.packageName, config.lockTask)
        } else {
            state.edit().clear().apply()
        }
        return CommandResult.success()
    }

    /** Start [pkg]'s launcher activity, in lock task when the kiosk asks for it. */
    fun launch(pkg: String, inLockTask: Boolean = config()?.let { it.packageName == pkg && it.lockTask } ?: false): Boolean {
        return try {
            val intent = context.packageManager.getLaunchIntentForPackage(pkg) ?: return false
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
            if (inLockTask && owner.isDeviceOwner()) {
                val opts = ActivityOptions.makeBasic().apply { setLockTaskEnabled(true) }
                context.startActivity(intent, opts.toBundle())
            } else {
                intent.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                context.startActivity(intent)
            }
            lastRelaunchMs = System.currentTimeMillis()
            true
        } catch (e: Exception) {
            Log.w(TAG, "Launch of $pkg failed: ${e.message}")
            false
        }
    }

    fun isInstalled(pkg: String): Boolean = try {
        context.packageManager.getPackageInfo(pkg, 0); true
    } catch (e: Exception) { false }

    /** Called from the poll loop. Relaunches the target if it is not in front (with a cooldown). */
    fun watchdogTick() {
        val target = target() ?: return
        val now = System.currentTimeMillis()
        if (KioskWatchdog.shouldRelaunch(target, isInstalled(target), foregroundPackage(), now, lastRelaunchMs)) {
            Log.i(TAG, "Watchdog: $target is not in the foreground, relaunching")
            launch(target)
        }
    }

    /** Package-added/replaced for [pkg]: relaunch if it is the target. */
    fun onPackageEvent(pkg: String?) {
        if (KioskWatchdog.shouldRelaunchOnPackageEvent(target(), pkg)) launch(pkg!!)
    }

    /**
     * Foreground package from UsageStats. Null when the usage-access permission is missing or no
     * recent event exists; the watchdog then treats the target as not in front.
     */
    private fun foregroundPackage(): String? = try {
        val usm = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        val now = System.currentTimeMillis()
        val events = usm.queryEvents(now - 10 * 60_000L, now)
        val e = UsageEvents.Event()
        var current: String? = null
        while (events.hasNextEvent()) {
            events.getNextEvent(e)
            if (e.eventType == UsageEvents.Event.ACTIVITY_RESUMED) current = e.packageName
            else if (e.eventType == UsageEvents.Event.ACTIVITY_PAUSED && e.packageName == current) current = null
        }
        current
    } catch (e: Exception) { null }

    /** Try to grant ourselves usage access so [foregroundPackage] works. Best effort. */
    fun tryGrantUsageAccess() {
        if (!owner.isDeviceOwner()) return
        runCatching {
            owner.policyManager.setPermissionGrantState(
                owner.adminComponent, context.packageName, "android.permission.PACKAGE_USAGE_STATS",
                DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED
            )
        }
    }

    private companion object { const val TAG = "KioskController" }
}

/** Receives PACKAGE_ADDED / PACKAGE_REPLACED. Registered dynamically by the polling service. */
class TargetPackageReceiver(private val controller: KioskController) : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_PACKAGE_ADDED && intent.action != Intent.ACTION_PACKAGE_REPLACED) return
        controller.onPackageEvent(intent.data?.schemeSpecificPart)
    }

    companion object {
        fun filter() = IntentFilter().apply {
            addAction(Intent.ACTION_PACKAGE_ADDED)
            addAction(Intent.ACTION_PACKAGE_REPLACED)
            addDataScheme("package")
        }
    }
}
