package com.androidremote.feature.input

/**
 * Detects whether root and the `input` command are usable.
 *
 * - Never blocks the Main thread: on Main it schedules the probe on [background] and
 *   reports the last known answer (false at first).
 * - A negative result is only cached for [retryAfterMs]; positive results are cached.
 *
 * @param exec runs argv and returns the exit code, or null if it could not be started.
 */
class ShellProbe(
    private val exec: (List<String>) -> Int?,
    private val isMainThread: () -> Boolean,
    private val clock: () -> Long,
    private val background: (Runnable) -> Unit,
    private val retryAfterMs: Long = 30_000L
) {
    @Volatile var rootMode: RootMode = RootMode.NONE
        private set
    @Volatile private var available = false
    @Volatile private var lastProbeAt = Long.MIN_VALUE
    @Volatile private var probed = false
    @Volatile private var inFlight = false
    private val lock = Any()

    fun isAvailable(): Boolean {
        if (probed && (available || clock() - lastProbeAt < retryAfterMs)) return available
        if (isMainThread()) {
            scheduleBackground()
            return available
        }
        probeNow()
        return available
    }

    /** Start a background probe if one is due. Safe to call from any thread. */
    fun warmUp() {
        if (probed && (available || clock() - lastProbeAt < retryAfterMs)) return
        scheduleBackground()
    }

    private fun scheduleBackground() {
        synchronized(lock) {
            if (inFlight) return
            inFlight = true
        }
        background(Runnable {
            try { probeNow() } finally { synchronized(lock) { inFlight = false } }
        })
    }

    private fun probeNow() {
        synchronized(lock) {
            val mode = when {
                exec(listOf("su", "0", "id") ) == 0 -> RootMode.SU_UID
                exec(listOf("su", "-c", "id")) == 0 -> RootMode.SU_C
                else -> RootMode.NONE
            }
            val code = exec(ShellCommands.wrap(listOf("input"), mode))
            // `input` with no args exits 1, which still means it exists.
            val ok = code == 0 || code == 1
            rootMode = mode
            available = ok
            lastProbeAt = clock()
            probed = true
        }
    }
}
