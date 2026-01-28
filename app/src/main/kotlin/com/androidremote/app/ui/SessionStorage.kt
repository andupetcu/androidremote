package com.androidremote.app.ui

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Secure storage for session credentials.
 *
 * Architecture:
 * - Enrollment data (server URL, device ID, enrolled flag) is stored in regular
 *   SharedPreferences to survive app updates and reinstalls.
 * - Session token (only truly sensitive data) is stored in EncryptedSharedPreferences.
 *
 * This separation ensures MDM enrollment persists across app updates while
 * still protecting the session token with encryption.
 */
class SessionStorage private constructor(
    private val enrollmentPrefs: SharedPreferences,
    private val securePrefs: SharedPreferences
) {

    companion object {
        private const val TAG = "SessionStorage"
        private const val PREFS_NAME_ENROLLMENT = "enrollment_prefs"
        private const val PREFS_NAME_SECURE = "session_prefs"
        private const val PREFS_NAME_SECURE_FALLBACK = "session_prefs_fallback"
        private const val KEY_SESSION_TOKEN = "session_token"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_ENROLLED = "enrolled"
        private const val KEY_ENROLLED_AT = "enrolled_at"
        private const val KEY_LAST_SYNC_TIME = "last_sync_time"
        private const val KEY_LAST_SYNC_SUCCESS = "last_sync_success"
        private const val KEY_LAST_SYNC_ERROR = "last_sync_error"
        private const val KEY_CONNECTION_STATUS = "connection_status"
        private const val KEY_INITIAL_SETUP_COMPLETE = "initial_setup_complete"

        /**
         * Create SessionStorage with separate storage for enrollment and secure data.
         * Enrollment data uses regular SharedPreferences (survives updates).
         * Session token uses EncryptedSharedPreferences (protected, may need re-auth after reinstall).
         */
        fun create(context: Context): SessionStorage {
            // Enrollment data - regular prefs (survives app updates and reinstalls with backup)
            val enrollmentPrefs = context.getSharedPreferences(PREFS_NAME_ENROLLMENT, Context.MODE_PRIVATE)

            // Migrate data from old encrypted prefs if needed
            migrateFromOldStorage(context, enrollmentPrefs)

            // Secure prefs for session token only
            val securePrefs = try {
                val masterKey = MasterKey.Builder(context)
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build()

                EncryptedSharedPreferences.create(
                    context,
                    PREFS_NAME_SECURE,
                    masterKey,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
                )
            } catch (e: Exception) {
                // Keystore unavailable or corrupted - fall back to regular prefs
                Log.w(TAG, "EncryptedSharedPreferences unavailable, using fallback", e)
                context.getSharedPreferences(PREFS_NAME_SECURE_FALLBACK, Context.MODE_PRIVATE)
            }

            return SessionStorage(enrollmentPrefs, securePrefs)
        }

        /**
         * Migrate data from old encrypted-only storage to new split storage.
         * This handles the case where user updates from old app version.
         */
        private fun migrateFromOldStorage(context: Context, enrollmentPrefs: SharedPreferences) {
            // Check if already migrated
            if (enrollmentPrefs.contains("_migrated_v2")) return

            try {
                // Try to read from old encrypted prefs
                val masterKey = MasterKey.Builder(context)
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build()

                val oldPrefs = EncryptedSharedPreferences.create(
                    context,
                    PREFS_NAME_SECURE,
                    masterKey,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
                )

                // Migrate enrollment data to regular prefs
                val deviceId = oldPrefs.getString(KEY_DEVICE_ID, null)
                val serverUrl = oldPrefs.getString(KEY_SERVER_URL, null)
                val enrolled = oldPrefs.getBoolean(KEY_ENROLLED, false)
                val enrolledAt = oldPrefs.getLong(KEY_ENROLLED_AT, 0)
                val setupComplete = oldPrefs.getBoolean(KEY_INITIAL_SETUP_COMPLETE, false)

                if (deviceId != null || serverUrl != null || enrolled) {
                    enrollmentPrefs.edit()
                        .putString(KEY_DEVICE_ID, deviceId)
                        .putString(KEY_SERVER_URL, serverUrl)
                        .putBoolean(KEY_ENROLLED, enrolled)
                        .putLong(KEY_ENROLLED_AT, enrolledAt)
                        .putBoolean(KEY_INITIAL_SETUP_COMPLETE, setupComplete)
                        .putBoolean("_migrated_v2", true)
                        .apply()
                    Log.i(TAG, "Migrated enrollment data from old storage")
                } else {
                    enrollmentPrefs.edit().putBoolean("_migrated_v2", true).apply()
                }
            } catch (e: Exception) {
                // Old encrypted prefs unreadable (common after reinstall with new Keystore)
                // Just mark as migrated and continue - user will need to re-enroll
                Log.w(TAG, "Could not migrate from old storage: ${e.message}")
                enrollmentPrefs.edit().putBoolean("_migrated_v2", true).apply()
            }
        }
    }

    // ========================================
    // Session Token (encrypted storage)
    // ========================================

    fun saveSessionToken(token: String) {
        securePrefs.edit().putString(KEY_SESSION_TOKEN, token).apply()
    }

    fun getSessionToken(): String? {
        return securePrefs.getString(KEY_SESSION_TOKEN, null)
    }

    // ========================================
    // Enrollment Data (regular storage - survives updates)
    // ========================================

    fun saveDeviceId(deviceId: String) {
        enrollmentPrefs.edit().putString(KEY_DEVICE_ID, deviceId).apply()
        Log.d(TAG, "Saved device ID: $deviceId")
    }

    fun getDeviceId(): String? {
        val deviceId = enrollmentPrefs.getString(KEY_DEVICE_ID, null)
        Log.d(TAG, "Retrieved device ID: $deviceId")
        return deviceId
    }

    fun saveServerUrl(url: String) {
        enrollmentPrefs.edit().putString(KEY_SERVER_URL, url).apply()
        Log.d(TAG, "Saved server URL: $url")
    }

    fun getServerUrl(): String? {
        val url = enrollmentPrefs.getString(KEY_SERVER_URL, null)
        Log.d(TAG, "Retrieved server URL: $url")
        return url
    }

    /**
     * Mark device as enrolled with MDM server.
     * This is stored permanently until unenrolled.
     */
    fun setEnrolled(enrolled: Boolean) {
        enrollmentPrefs.edit()
            .putBoolean(KEY_ENROLLED, enrolled)
            .putLong(KEY_ENROLLED_AT, if (enrolled) System.currentTimeMillis() else 0)
            .apply()
        Log.d(TAG, "Set enrolled: $enrolled")
    }

    /**
     * Check if device is enrolled with MDM server.
     */
    fun isEnrolled(): Boolean {
        val enrolled = enrollmentPrefs.getBoolean(KEY_ENROLLED, false)
        Log.d(TAG, "isEnrolled() returning: $enrolled")
        return enrolled
    }

    /**
     * Get enrollment timestamp.
     */
    fun getEnrolledAt(): Long {
        return enrollmentPrefs.getLong(KEY_ENROLLED_AT, 0)
    }

    /**
     * Clear session data (for disconnect).
     * Does NOT clear enrollment state.
     */
    fun clearSession() {
        securePrefs.edit()
            .remove(KEY_SESSION_TOKEN)
            .apply()
    }

    /**
     * Clear all data including enrollment (for unenroll/factory reset).
     */
    fun clear() {
        // Clear secure data
        securePrefs.edit()
            .remove(KEY_SESSION_TOKEN)
            .apply()

        // Clear enrollment data
        enrollmentPrefs.edit()
            .remove(KEY_DEVICE_ID)
            .remove(KEY_SERVER_URL)
            .remove(KEY_ENROLLED)
            .remove(KEY_ENROLLED_AT)
            .remove(KEY_LAST_SYNC_TIME)
            .remove(KEY_LAST_SYNC_SUCCESS)
            .remove(KEY_LAST_SYNC_ERROR)
            .remove(KEY_CONNECTION_STATUS)
            .remove(KEY_INITIAL_SETUP_COMPLETE)
            .apply()
    }

    /**
     * Mark that initial setup (permissions) has been completed.
     * Once set, skip permissions screen on subsequent launches.
     */
    fun setInitialSetupComplete(complete: Boolean) {
        enrollmentPrefs.edit().putBoolean(KEY_INITIAL_SETUP_COMPLETE, complete).apply()
    }

    /**
     * Check if initial setup has been completed.
     */
    fun isInitialSetupComplete(): Boolean {
        return enrollmentPrefs.getBoolean(KEY_INITIAL_SETUP_COMPLETE, false)
    }

    // ========================================
    // Sync Status Tracking
    // ========================================

    /**
     * Connection status for display on Managed screen.
     */
    enum class ConnectionStatus {
        CONNECTING,
        ONLINE,
        OFFLINE,
        ERROR
    }

    /**
     * Update sync status after a telemetry sync attempt.
     */
    fun updateSyncStatus(success: Boolean, error: String? = null) {
        enrollmentPrefs.edit()
            .putLong(KEY_LAST_SYNC_TIME, System.currentTimeMillis())
            .putBoolean(KEY_LAST_SYNC_SUCCESS, success)
            .putString(KEY_LAST_SYNC_ERROR, if (success) null else error)
            .putString(KEY_CONNECTION_STATUS, if (success) ConnectionStatus.ONLINE.name else ConnectionStatus.ERROR.name)
            .apply()
    }

    /**
     * Get the last sync timestamp.
     */
    fun getLastSyncTime(): Long {
        return enrollmentPrefs.getLong(KEY_LAST_SYNC_TIME, 0)
    }

    /**
     * Check if the last sync was successful.
     */
    fun wasLastSyncSuccessful(): Boolean {
        return enrollmentPrefs.getBoolean(KEY_LAST_SYNC_SUCCESS, false)
    }

    /**
     * Get the last sync error message (if any).
     */
    fun getLastSyncError(): String? {
        return enrollmentPrefs.getString(KEY_LAST_SYNC_ERROR, null)
    }

    /**
     * Get current connection status.
     */
    fun getConnectionStatus(): ConnectionStatus {
        val statusStr = enrollmentPrefs.getString(KEY_CONNECTION_STATUS, ConnectionStatus.CONNECTING.name)
        return try {
            ConnectionStatus.valueOf(statusStr ?: ConnectionStatus.CONNECTING.name)
        } catch (e: Exception) {
            ConnectionStatus.CONNECTING
        }
    }

    /**
     * Set connection status.
     */
    fun setConnectionStatus(status: ConnectionStatus) {
        enrollmentPrefs.edit().putString(KEY_CONNECTION_STATUS, status.name).apply()
    }
}
