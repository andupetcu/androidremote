package com.androidremote.app.mdm

/**
 * Per-package backoff for automatic updates. After a failed install of a version, that package
 * waits base, 2x base, 4x base ... up to [maxMs] before it is tried again. A newer version on the
 * server is tried at once, and a successful install clears the entry. Other packages are unaffected.
 */
class UpdateBackoff(
    private val baseMs: Long = 5 * 60_000L,
    private val maxMs: Long = 6 * 60 * 60_000L
) {
    private data class Entry(val versionCode: Long, val failures: Int, val nextAttemptAt: Long)

    private val entries = mutableMapOf<String, Entry>()

    @Synchronized
    fun mayAttempt(packageName: String, versionCode: Long, now: Long): Boolean {
        val e = entries[packageName] ?: return true
        return e.versionCode != versionCode || now >= e.nextAttemptAt
    }

    @Synchronized
    fun nextAttemptAt(packageName: String, versionCode: Long): Long? =
        entries[packageName]?.takeIf { it.versionCode == versionCode }?.nextAttemptAt

    @Synchronized
    fun recordFailure(packageName: String, versionCode: Long, now: Long) {
        val prev = entries[packageName]?.takeIf { it.versionCode == versionCode }
        val failures = (prev?.failures ?: 0) + 1
        val wait = minOf(maxMs, baseMs * (1L shl (failures - 1).coerceIn(0, 30)))
        entries[packageName] = Entry(versionCode, failures, now + wait)
    }

    @Synchronized
    fun recordSuccess(packageName: String) {
        entries.remove(packageName)
    }
}
