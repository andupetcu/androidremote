package com.androidremote.app.mdm

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

data class InstalledApp(
    val packageName: String,
    val appName: String,
    val versionName: String,
    val versionCode: Long,
    val isSystemApp: Boolean,
    val enabled: Boolean
)

@Serializable
internal data class InventoryEntry(
    val packageName: String,
    val appName: String,
    val versionName: String,
    val versionCode: Long,
    val isSystemApp: Boolean,
    val enabled: Boolean
)

@Serializable
internal data class InventoryBody(val apps: List<InventoryEntry>)

/** Builds the `{ "apps": [...] }` body with kotlinx.serialization, so every character is escaped. */
object AppInventory {
    fun toJson(apps: List<InstalledApp>): String = Json.encodeToString(
        InventoryBody(apps.map {
            InventoryEntry(it.packageName, it.appName, it.versionName, it.versionCode, it.isSystemApp, it.enabled)
        })
    )
}
