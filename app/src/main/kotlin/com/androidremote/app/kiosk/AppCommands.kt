package com.androidremote.app.kiosk

import android.app.admin.DevicePolicyManager
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject

object ProtectedPackages {
    /** Returns the refusal text, or null when [action] on [pkg] is allowed. Self is always protected. */
    fun refusal(pkg: String, ownPackage: String, protected: Set<String>, action: String): String? =
        if (pkg == ownPackage || pkg in protected) "$action refused: $pkg is a protected package" else null

    /** SET_PROTECTED_PACKAGES payload; null when 'packages' is missing. */
    fun parse(payload: JsonObject): Set<String>? {
        val arr = payload["packages"] as? JsonArray ?: return null
        return arr.mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.trim() }
            .filter { PACKAGE_NAME_REGEX.matches(it) }
            .toSet()
    }
}

object WipeGuard {
    /** WIPE needs `confirm` equal to this device's id (contract C10). Returns an error or null. */
    fun check(payload: JsonObject, deviceId: String?): String? {
        if (deviceId.isNullOrEmpty()) return "Wipe refused: device id unknown"
        val confirm = payload.string("confirm")
        if (confirm.isNullOrEmpty() || confirm != deviceId) return "Wipe refused: payload.confirm must equal the device id"
        return null
    }

    fun flags(payload: JsonObject): Int =
        if (payload.bool("wipeExternalStorage") == true) DevicePolicyManager.WIPE_EXTERNAL_STORAGE else 0
}

object GrantStates {
    fun fromName(name: String?): Int? = when (name) {
        "granted" -> DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED
        "denied" -> DevicePolicyManager.PERMISSION_GRANT_STATE_DENIED
        "default" -> DevicePolicyManager.PERMISSION_GRANT_STATE_DEFAULT
        else -> null
    }
}

data class RequiredApp(val packageName: String, val foreground: Boolean, val autoStartOnBoot: Boolean)

/** SYNC_POLICY: a null field means the payload did not carry it, so the device leaves it alone (AM-09). */
data class PolicyUpdate(
    val silentMode: Boolean?,
    val kioskMode: Boolean?,
    val requiredApps: List<RequiredApp>?,
    val updateWindowProvided: Boolean,
    val updateWindow: MaintenanceWindow?
) {
    companion object {
        fun parse(payload: JsonObject): PolicyUpdate {
            val apps = (payload["requiredApps"] as? JsonArray)?.mapNotNull { el ->
                val o = (el as? JsonObject) ?: return@mapNotNull null
                val pkg = o.string("packageName") ?: return@mapNotNull null
                RequiredApp(pkg, o.bool("foregroundApp") ?: false, o.bool("autoStartOnBoot") ?: false)
            }
            val provided = payload.containsKey("updateWindow")
            val w = payload["updateWindow"]
            val window = if (w is JsonObject) MaintenanceWindow.parse(w.string("start"), w.string("end")) else null
            return PolicyUpdate(payload.bool("silentMode"), payload.bool("kioskMode"), apps, provided, window)
        }
    }
}

object BootAppsMerge {
    /** Authoritative boot map from the policy: only installed apps with a flag; the last foreground app wins. */
    fun fromRequired(apps: List<RequiredApp>, isInstalled: (String) -> Boolean): Map<String, Boolean> {
        val out = LinkedHashMap<String, Boolean>()
        for (a in apps) {
            if (!(a.foreground || a.autoStartOnBoot) || !isInstalled(a.packageName)) continue
            if (a.foreground) out.entries.removeAll { it.value }
            out[a.packageName] = a.foreground
        }
        return out
    }
}
