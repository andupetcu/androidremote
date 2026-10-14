package com.androidremote.app.service

/** Capped exponential backoff for (re)starting screen capture while the session is alive. */
class CaptureRetryPolicy(
    private val baseDelayMs: Long = 1_000,
    private val maxDelayMs: Long = 30_000,
) {
    /** Delay before retry number [attempt] (1 = first retry). */
    fun delayMs(attempt: Int): Long {
        val n = (attempt - 1).coerceIn(0, 30)
        val raw = baseDelayMs shl n
        return if (raw <= 0 || raw > maxDelayMs) maxDelayMs else raw
    }
}
