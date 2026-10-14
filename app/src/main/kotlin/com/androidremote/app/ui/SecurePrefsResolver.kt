package com.androidremote.app.ui

import android.content.SharedPreferences

/**
 * Picks the store for the session token (AM-15).
 *
 * The token is never written to a plaintext file: if EncryptedSharedPreferences cannot be
 * created (even after resetting a corrupted store once), the token lives in memory only.
 * The device then has to re-authenticate after a restart, and the caller can surface
 * [Resolved.persistent] == false to the user.
 */
object SecurePrefsResolver {

    class Resolved(val prefs: SharedPreferences, val persistent: Boolean)

    fun resolve(
        create: () -> SharedPreferences,
        reset: () -> Unit,
        onError: (Throwable) -> Unit = { }
    ): Resolved {
        try {
            return Resolved(create(), true)
        } catch (e: Exception) {
            onError(e)
        }
        try {
            reset()
            return Resolved(create(), true)
        } catch (e: Exception) {
            onError(e)
        }
        return Resolved(InMemoryPrefs(), false)
    }
}

/** Minimal in-memory SharedPreferences. Not persisted, never backed up. */
class InMemoryPrefs : SharedPreferences {
    private val map = HashMap<String, Any?>()

    @Synchronized override fun getAll(): MutableMap<String, *> = HashMap(map)
    @Synchronized override fun getString(key: String, defValue: String?): String? = map[key] as? String ?: defValue
    @Suppress("UNCHECKED_CAST")
    @Synchronized override fun getStringSet(key: String, defValues: MutableSet<String>?): MutableSet<String>? =
        (map[key] as? Set<String>)?.toMutableSet() ?: defValues
    @Synchronized override fun getInt(key: String, defValue: Int): Int = map[key] as? Int ?: defValue
    @Synchronized override fun getLong(key: String, defValue: Long): Long = map[key] as? Long ?: defValue
    @Synchronized override fun getFloat(key: String, defValue: Float): Float = map[key] as? Float ?: defValue
    @Synchronized override fun getBoolean(key: String, defValue: Boolean): Boolean = map[key] as? Boolean ?: defValue
    @Synchronized override fun contains(key: String): Boolean = map.containsKey(key)
    override fun registerOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) {}
    override fun unregisterOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) {}

    override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
        private val pending = HashMap<String, Any?>()
        private val removals = HashSet<String>()
        private var clear = false
        override fun putString(key: String, value: String?) = apply { pending[key] = value }
        override fun putStringSet(key: String, values: MutableSet<String>?) = apply { pending[key] = values?.toSet() }
        override fun putInt(key: String, value: Int) = apply { pending[key] = value }
        override fun putLong(key: String, value: Long) = apply { pending[key] = value }
        override fun putFloat(key: String, value: Float) = apply { pending[key] = value }
        override fun putBoolean(key: String, value: Boolean) = apply { pending[key] = value }
        override fun remove(key: String) = apply { removals += key }
        override fun clear() = apply { clear = true }
        override fun commit(): Boolean { flush(); return true }
        override fun apply() { flush() }
        private fun flush() = synchronized(this@InMemoryPrefs) {
            if (clear) map.clear()
            removals.forEach { map.remove(it) }
            pending.forEach { (k, v) -> if (v == null) map.remove(k) else map[k] = v }
        }
    }
}
