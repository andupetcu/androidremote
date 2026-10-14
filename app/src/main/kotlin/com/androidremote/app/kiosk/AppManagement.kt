package com.androidremote.app.kiosk

import android.content.Context
import android.util.Log
import com.androidremote.app.admin.DeviceOwnerManager
import com.androidremote.app.mdm.CommandResult
import kotlinx.serialization.json.JsonObject

/** Device-side handlers for DISABLE_APP, ENABLE_APP, GRANT_PERMISSION, SET_PROTECTED_PACKAGES (contract C10). */
class AppManagement(private val context: Context, private val owner: DeviceOwnerManager) {
    private val prefs = context.getSharedPreferences("protected_packages", Context.MODE_PRIVATE)

    fun protectedPackages(): Set<String> = prefs.getStringSet("packages", emptySet()) ?: emptySet()

    /** Refusal text for UNINSTALL_APP, or null when allowed. */
    fun uninstallRefusal(pkg: String): String? =
        ProtectedPackages.refusal(pkg, context.packageName, protectedPackages(), "UNINSTALL_APP")

    fun setProtectedPackages(payload: JsonObject): CommandResult {
        val set = ProtectedPackages.parse(payload) ?: return CommandResult.failure("Missing 'packages' array")
        prefs.edit().putStringSet("packages", set).apply()
        return CommandResult.success()
    }

    fun disableApp(payload: JsonObject): CommandResult {
        val pkg = packageOf(payload) ?: return CommandResult.failure("Missing or invalid packageName")
        ProtectedPackages.refusal(pkg, context.packageName, protectedPackages(), "DISABLE_APP")?.let { return CommandResult.failure(it) }
        return setHidden(pkg, true)
    }

    fun enableApp(payload: JsonObject): CommandResult {
        val pkg = packageOf(payload) ?: return CommandResult.failure("Missing or invalid packageName")
        return setHidden(pkg, false)
    }

    fun grantPermission(payload: JsonObject): CommandResult {
        if (!owner.isDeviceOwner()) return CommandResult.failure("GRANT_PERMISSION requires Device Owner privileges")
        val pkg = packageOf(payload) ?: return CommandResult.failure("Missing or invalid packageName")
        val permission = payload.string("permission")?.takeIf { it.isNotBlank() }
            ?: return CommandResult.failure("Missing permission")
        val state = GrantStates.fromName(payload.string("state"))
            ?: return CommandResult.failure("state must be granted, denied or default")
        return try {
            if (owner.policyManager.setPermissionGrantState(owner.adminComponent, pkg, permission, state)) CommandResult.success()
            else CommandResult.failure("System refused to change $permission for $pkg")
        } catch (e: SecurityException) {
            Log.w(TAG, "setPermissionGrantState failed", e)
            CommandResult.failure("Not allowed to change $permission: ${e.message}")
        }
    }

    private fun setHidden(pkg: String, hidden: Boolean): CommandResult {
        if (!owner.isDeviceOwner()) return CommandResult.failure("Requires Device Owner privileges")
        return try {
            if (owner.policyManager.setApplicationHidden(owner.adminComponent, pkg, hidden)) CommandResult.success()
            else CommandResult.failure("System could not ${if (hidden) "disable" else "enable"} $pkg (not installed?)")
        } catch (e: SecurityException) {
            CommandResult.failure("Not allowed: ${e.message}")
        }
    }

    private fun packageOf(payload: JsonObject): String? =
        payload.string("packageName")?.takeIf { PACKAGE_NAME_REGEX.matches(it) }

    private companion object { const val TAG = "AppManagement" }
}
