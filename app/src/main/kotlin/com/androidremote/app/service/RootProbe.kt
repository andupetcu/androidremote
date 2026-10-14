package com.androidremote.app.service

import android.util.Log
import java.util.concurrent.TimeUnit

/**
 * Does `su` really give uid 0? (A su binary that exists but denies the app is not root.)
 * Blocking: call off the main thread. A positive answer is cached; a negative one is re-probed after
 * [NEGATIVE_TTL_MS] so granting su later is picked up.
 */
class RootProbe(
    private val clock: () -> Long = System::currentTimeMillis,
    /** Runs `su -c id` and returns its output, or null when su is missing or fails. */
    private val runSu: () -> String? = ::defaultRunSu,
) {
    @Volatile private var cached: Boolean? = null
    @Volatile private var cachedAt = 0L

    @Synchronized
    fun isRootWorking(): Boolean {
        val known = cached
        if (known == true || (known == false && clock() - cachedAt < NEGATIVE_TTL_MS)) return known
        val result = try {
            runSu()?.contains("uid=0") == true
        } catch (e: Exception) {
            false
        }
        cached = result
        cachedAt = clock()
        return result
    }

    companion object {
        private const val TAG = "RootProbe"
        const val NEGATIVE_TTL_MS = 30_000L

        /** Process-wide instance shared by capture, START_REMOTE and telemetry. */
        val shared = RootProbe()

        private fun defaultRunSu(): String? = try {
            val p = ProcessBuilder("su", "-c", "id").redirectErrorStream(true).start()
            if (!p.waitFor(5, TimeUnit.SECONDS)) {
                p.destroyForcibly()
                null
            } else if (p.exitValue() == 0) p.inputStream.bufferedReader().readText() else null
        } catch (e: Exception) {
            Log.d(TAG, "su unavailable: ${e.message}")
            null
        }
    }
}
