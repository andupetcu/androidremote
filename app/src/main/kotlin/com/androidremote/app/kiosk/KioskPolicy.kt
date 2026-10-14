package com.androidremote.app.kiosk

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/** Same pattern the server enforces on upload (contract C6). */
internal val PACKAGE_NAME_REGEX = Regex("^[a-zA-Z][a-zA-Z0-9_]*(\\.[a-zA-Z][a-zA-Z0-9_]*)+$")

internal fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeUnless { it is kotlinx.serialization.json.JsonNull }?.contentOrNull

internal fun JsonObject.bool(key: String): Boolean? =
    (this[key] as? JsonPrimitive)?.contentOrNull?.toBooleanStrictOrNull()

/** SET_KIOSK payload (contract C10). */
data class KioskConfig(val packageName: String, val enabled: Boolean, val lockTask: Boolean)

sealed class KioskParse {
    data class Ok(val config: KioskConfig) : KioskParse()
    data class Invalid(val reason: String) : KioskParse()
}

/** What applying a [KioskConfig] means, as plain data. [KioskController] turns this into DPM calls. */
data class KioskPlan(
    val lockTaskPackages: List<String>,
    val launchInLockTask: Boolean,
    val homeReplacementPackage: String?,
    val keyguardDisabled: Boolean,
    val statusBarDisabled: Boolean,
    /** Package that becomes the boot foreground app, or null. */
    val bootForeground: String?,
    /** Package whose boot/foreground preference must be removed, or null. */
    val clearBootPackage: String?
)

object KioskPolicy {
    fun parse(payload: JsonObject): KioskParse {
        val pkg = payload.string("packageName")
        if (pkg == null || !PACKAGE_NAME_REGEX.matches(pkg)) return KioskParse.Invalid("Missing or invalid packageName")
        val enabled = payload.bool("enabled") ?: return KioskParse.Invalid("Missing 'enabled'")
        val lockTask = payload.bool("lockTask") ?: false
        return KioskParse.Ok(KioskConfig(pkg, enabled, lockTask))
    }

    fun plan(config: KioskConfig, ownPackage: String): KioskPlan {
        if (!config.enabled) {
            return KioskPlan(
                lockTaskPackages = listOf(ownPackage),
                launchInLockTask = false,
                homeReplacementPackage = null,
                keyguardDisabled = false,
                statusBarDisabled = false,
                bootForeground = null,
                clearBootPackage = config.packageName
            )
        }
        return KioskPlan(
            lockTaskPackages = if (config.lockTask) listOf(config.packageName, ownPackage).distinct() else listOf(ownPackage),
            launchInLockTask = config.lockTask,
            homeReplacementPackage = if (config.lockTask) null else config.packageName,
            keyguardDisabled = true,
            statusBarDisabled = true,
            bootForeground = config.packageName,
            clearBootPackage = null
        )
    }
}

object KioskWatchdog {
    const val DEFAULT_COOLDOWN_MS = 30_000L

    /** The app that must stay in front: the kiosk target, else the boot foreground app. */
    fun targetOf(kioskPackage: String?, foregroundBootApp: String?): String? = kioskPackage ?: foregroundBootApp

    fun shouldRelaunch(
        target: String?,
        installed: Boolean,
        foregroundPackage: String?,
        nowMs: Long,
        lastRelaunchMs: Long?,
        cooldownMs: Long = DEFAULT_COOLDOWN_MS
    ): Boolean {
        if (target == null || !installed) return false
        if (foregroundPackage == target) return false
        if (lastRelaunchMs != null && nowMs - lastRelaunchMs < cooldownMs) return false
        return true
    }

    fun shouldRelaunchOnPackageEvent(target: String?, eventPackage: String?): Boolean =
        target != null && target == eventPackage
}

/** Daily maintenance window in minutes since midnight. start > end means it crosses midnight. */
data class MaintenanceWindow(val startMinute: Int, val endMinute: Int) {
    fun isOpen(minuteOfDay: Int): Boolean =
        if (startMinute < endMinute) minuteOfDay in startMinute until endMinute
        else minuteOfDay >= startMinute || minuteOfDay < endMinute

    companion object {
        private fun minutes(s: String?): Int? {
            val m = Regex("^(\\d{1,2}):(\\d{2})$").matchEntire(s?.trim() ?: return null) ?: return null
            val h = m.groupValues[1].toInt()
            val min = m.groupValues[2].toInt()
            return if (h in 0..23 && min in 0..59) h * 60 + min else null
        }

        fun parse(start: String?, end: String?): MaintenanceWindow? {
            val s = minutes(start) ?: return null
            val e = minutes(end) ?: return null
            return if (s == e) null else MaintenanceWindow(s, e)
        }
    }
}

object UpdatePolicy {
    /** No window configured means install immediately. */
    fun mayInstallNow(window: MaintenanceWindow?, minuteOfDay: Int): Boolean = window?.isOpen(minuteOfDay) ?: true
}

enum class BootStep { START_POLLING, APPLY_SILENT_MODE, LAUNCH_BOOT_APPS, LAUNCH_FOREGROUND }

/**
 * The one boot path (AM-10). LOCKED_BOOT_COMPLETED fires before the first unlock, when only
 * device-protected storage (the kiosk record) can be read. BOOT_COMPLETED does everything else.
 */
object BootPlan {
    const val LOCKED_BOOT = "android.intent.action.LOCKED_BOOT_COMPLETED"
    const val BOOT = "android.intent.action.BOOT_COMPLETED"

    fun stepsFor(
        action: String?,
        enrolled: Boolean,
        silentMode: Boolean,
        kioskConfigured: Boolean,
        hasBootApps: Boolean,
        hasForeground: Boolean
    ): List<BootStep> = when (action) {
        LOCKED_BOOT -> if (kioskConfigured) listOf(BootStep.LAUNCH_FOREGROUND) else emptyList()
        BOOT -> buildList {
            if (enrolled) add(BootStep.START_POLLING)
            if (silentMode) add(BootStep.APPLY_SILENT_MODE)
            if (hasBootApps) add(BootStep.LAUNCH_BOOT_APPS)
            if (hasForeground || kioskConfigured) add(BootStep.LAUNCH_FOREGROUND)
        }
        else -> emptyList()
    }
}
