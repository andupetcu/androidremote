package com.androidremote.app.mdm.telemetry

import java.io.File

/**
 * Bounded, file-backed FIFO of serialized telemetry samples (one JSON object per line).
 * Oldest samples are discarded once [capacity] is exceeded. Thread-safe.
 */
class SampleRingBuffer(private val file: File, private val capacity: Int = 1000) {
    private val lines = ArrayDeque<String>()

    init {
        if (file.exists()) {
            runCatching { file.readLines().filter { it.isNotBlank() } }.getOrDefault(emptyList())
                .takeLast(capacity).forEach { lines.addLast(it) }
        }
    }

    val size: Int @Synchronized get() = lines.size

    @Synchronized
    fun append(sample: String) {
        val single = sample.replace('\n', ' ').replace('\r', ' ')
        lines.addLast(single)
        if (lines.size > capacity) {
            while (lines.size > capacity) lines.removeFirst()
            persist()
        } else {
            runCatching { file.parentFile?.mkdirs(); file.appendText(single + "\n") }
        }
    }

    @Synchronized
    fun peek(n: Int): List<String> = lines.take(n)

    @Synchronized
    fun drop(n: Int) {
        repeat(minOf(n, lines.size)) { lines.removeFirst() }
        persist()
    }

    private fun persist() {
        runCatching {
            file.parentFile?.mkdirs()
            val tmp = File(file.path + ".tmp")
            tmp.writeText(lines.joinToString("") { it + "\n" })
            if (!tmp.renameTo(file)) { file.delete(); tmp.renameTo(file) }
        }
    }
}

enum class BatchOutcome { OK, NOT_FOUND, FAILED }

/**
 * Sends buffered samples oldest first. Samples are removed only after the server accepted them.
 * Uses the batch endpoint, falling back to single posts if it answers 404 (remembered).
 */
class TelemetryFlusher(
    private val buffer: SampleRingBuffer,
    private val sendBatch: suspend (List<String>) -> BatchOutcome,
    private val sendSingle: suspend (String) -> Boolean,
    private val batchSize: Int = 100
) {
    @Volatile var batchSupported = true
        private set

    /** Returns true when the buffer is empty afterwards. */
    suspend fun flush(): Boolean {
        while (buffer.size > 0) {
            val chunk = buffer.peek(batchSize)
            if (batchSupported && chunk.size > 1) {
                when (sendBatch(chunk)) {
                    BatchOutcome.OK -> buffer.drop(chunk.size)
                    BatchOutcome.FAILED -> return false
                    BatchOutcome.NOT_FOUND -> batchSupported = false
                }
            } else {
                if (!sendSingle(chunk.first())) return false
                buffer.drop(1)
            }
        }
        return true
    }
}

object ReportInterval {
    const val DEFAULT_MS = 60_000L
    const val MIN_MS = 15_000L
    const val MAX_MS = 3_600_000L

    fun from(serverMs: Long?): Long =
        if (serverMs == null || serverMs <= 0) DEFAULT_MS else serverMs.coerceIn(MIN_MS, MAX_MS)
}

class ReportSchedule {
    @Volatile var intervalMs: Long = ReportInterval.DEFAULT_MS
        private set
    @Volatile private var lastReportAt: Long? = null

    fun update(serverMs: Long?) { intervalMs = ReportInterval.from(serverMs) }
    fun markReported(now: Long) { lastReportAt = now }
    fun isDue(now: Long): Boolean = lastReportAt.let { it == null || now - it >= intervalMs }
}

data class LocationFix(val latitude: Double, val longitude: Double, val accuracy: Float, val timeMs: Long)

object LocationPolicy {
    const val MAX_AGE_MS = 15 * 60_000L

    fun shouldRequest(enabled: Boolean, granted: Boolean) = enabled && granted

    /** Most accurate fix no older than [MAX_AGE_MS], else null. Never cached across calls. */
    fun select(fixes: List<LocationFix>, now: Long): LocationFix? =
        fixes.filter { now - it.timeMs <= MAX_AGE_MS }.minByOrNull { it.accuracy }
}
