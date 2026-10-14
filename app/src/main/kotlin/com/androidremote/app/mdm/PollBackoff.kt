package com.androidremote.app.mdm

import android.util.Log
import com.androidremote.app.api.CommandApiException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

/**
 * Delay between polls after consecutive failures: base, 2x base, 4x base ... up to [maxMs],
 * shortened by up to 20% random jitter. The jitter never lengthens the delay, so the cap holds.
 */
class PollBackoff(
    private val baseMs: Long,
    private val maxMs: Long = 300_000L,
    private val random: () -> Double = { Math.random() }
) {
    fun delayAfterFailures(failures: Int): Long {
        val shift = failures.coerceIn(0, 30)
        val raw = minOf(maxMs, baseMs * (1L shl shift))
        val jittered = raw * (1.0 - 0.2 * random().coerceIn(0.0, 1.0))
        return jittered.toLong()
    }
}

/**
 * The poll loop. Calls [pollOnce] until [isActive] turns false. A failure backs the delay off;
 * a success resets it. A 401 or 404 means the enrollment is invalid: the loop reports it via
 * [onEnrollmentInvalid] and returns without polling again.
 */
suspend fun runPollLoop(
    baseMs: Long,
    backoff: PollBackoff,
    isActive: () -> Boolean,
    pollOnce: suspend () -> Unit,
    onEnrollmentInvalid: (CommandApiException) -> Unit,
    sleep: suspend (Long) -> Unit = { delay(it) }
) {
    var failures = 0
    while (isActive()) {
        try {
            pollOnce()
            failures = 0
        } catch (e: CancellationException) {
            throw e
        } catch (e: CommandApiException) {
            if (e.isEnrollmentInvalid) {
                Log.e("PollLoop", "Enrollment invalid (${e.errorType}); stopping polling")
                onEnrollmentInvalid(e)
                return
            }
            failures++
            Log.w("PollLoop", "Poll failed (#$failures): ${e.message}")
        } catch (e: Exception) {
            failures++
            Log.w("PollLoop", "Poll failed (#$failures): ${e.javaClass.simpleName}: ${e.message}")
        }
        if (!isActive()) return
        sleep(if (failures == 0) baseMs else backoff.delayAfterFailures(failures))
    }
}
