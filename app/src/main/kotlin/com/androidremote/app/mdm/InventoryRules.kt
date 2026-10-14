package com.androidremote.app.mdm

/** Decisions behind the app inventory, kept pure so they can be tested without a device. */
object InventoryRules {
    private val REFRESH_TYPES = setOf("DISABLE_APP", "ENABLE_APP", "UNINSTALL_APP", "INSTALL_APK")

    /** An app hidden through DISABLE_APP (setApplicationHidden) is reported as disabled. */
    fun enabled(infoEnabled: Boolean, hidden: Boolean): Boolean = infoEnabled && !hidden

    /** Hidden apps count as uninstalled for the package manager, so they are listed explicitly. */
    fun include(installedFlag: Boolean, hidden: Boolean): Boolean = installedFlag || hidden

    fun refreshAfter(commandType: String, success: Boolean): Boolean = success && commandType in REFRESH_TYPES
}
