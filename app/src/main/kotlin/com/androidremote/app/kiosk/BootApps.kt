package com.androidremote.app.kiosk

import android.content.SharedPreferences

/** The "boot_apps" preference: package -> true (foreground) or false (plain boot-start). */
class BootApps(private val prefs: SharedPreferences) {
    fun all(): Map<String, Boolean> =
        prefs.all.mapNotNull { (k, v) -> (v as? Boolean)?.let { k to it } }.toMap()

    fun foreground(): String? = all().entries.firstOrNull { it.value }?.key

    fun save(packageName: String, foreground: Boolean) {
        val e = prefs.edit()
        if (foreground) all().filterValues { it }.keys.forEach { e.remove(it) }
        e.putBoolean(packageName, foreground).apply()
    }

    fun remove(packageName: String) {
        prefs.edit().remove(packageName).apply()
    }

    fun replaceAll(map: Map<String, Boolean>) {
        val e = prefs.edit().clear()
        map.forEach { (k, v) -> e.putBoolean(k, v) }
        e.apply()
    }

    companion object {
        const val PREFS = "boot_apps"
    }
}
