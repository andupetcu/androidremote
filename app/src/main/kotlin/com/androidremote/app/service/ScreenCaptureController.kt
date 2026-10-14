package com.androidremote.app.service

import com.androidremote.transport.FrameData
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** One connection to the screen-server (implemented by [ScreenServerClient]). */
interface ScreenStream {
    val frames: Flow<FrameData>
    var onScreenInfo: ((width: Int, height: Int, rotation: Int) -> Unit)?
    /** Called once when the stream ends. `early` = it ended before the first frame arrived. */
    var onEnded: ((early: Boolean) -> Unit)?
    suspend fun connect(): Boolean
    fun disconnect()
    fun requestKeyFrame()
}

/** What the controller needs from the device (implemented by [ScreenServerBackend]). */
interface CaptureBackend {
    fun isRooted(): Boolean
    suspend fun isServerRunning(): Boolean
    suspend fun restartServer(): Boolean
    fun newStream(): ScreenStream
}

object CaptureFailureReason {
    const val CONSENT_REQUIRED = "consent_required"
    const val SERVER_UNREACHABLE = "screen_server_unreachable"
    const val CAPTURE_SETUP_FAILED = "capture_setup_failed"
    const val SERVER_DIED = "screen_server_died"
}

/**
 * Keeps screen capture alive for as long as a remote session is (AR-07).
 *
 * start() launches a supervisor that starts or restarts the screen-server (root), connects,
 * and retries with backoff on any failure. Each distinct failure is reported once through
 * [onCaptureFailed] (the session layer turns it into the CAPTURE_FAILED data-channel message);
 * the report is re-armed when frames flow again. On a device with no root and no running
 * server the reason is [CaptureFailureReason.CONSENT_REQUIRED]: a human must grant
 * MediaProjection consent, after which the session layer starts MediaProjection capture and
 * calls [stop]. If someone starts the server over adb in the meantime, the supervisor picks it up.
 */
class ScreenCaptureController(
    private val scope: CoroutineScope,
    private val backend: CaptureBackend,
    private val policy: CaptureRetryPolicy = CaptureRetryPolicy(),
) {
    private val _frames = MutableSharedFlow<FrameData>(replay = 0, extraBufferCapacity = 2)
    val frames: SharedFlow<FrameData> = _frames.asSharedFlow()

    /** Called at start and on every rotation or resolution change. Rotation is 0, 90, 180 or 270. */
    @Volatile var onScreenInfo: ((width: Int, height: Int, rotation: Int) -> Unit)? = null

    /** Called with a short reason string, once per distinct failure. */
    @Volatile var onCaptureFailed: ((reason: String) -> Unit)? = null

    @Volatile private var job: Job? = null
    @Volatile private var current: ScreenStream? = null
    @Volatile private var lastReported: String? = null

    /** Ask the encoder for a sync frame; no-op when not connected. */
    fun requestKeyFrame() {
        current?.requestKeyFrame()
    }

    fun start() {
        if (job?.isActive == true) return
        lastReported = null
        job = scope.launch { supervise() }
    }

    fun stop() {
        job?.cancel()
        job = null
        current?.disconnect()
        current = null
    }

    private fun report(reason: String) {
        if (reason == lastReported) return
        lastReported = reason
        onCaptureFailed?.invoke(reason)
    }

    private suspend fun supervise() {
        var attempt = 0
        // A running server is reused (it may have been pre-started at boot); restart only after a failure.
        var forceRestart = false
        while (scope.isActive) {
            val rooted = backend.isRooted()
            if (!rooted && !backend.isServerRunning()) {
                report(CaptureFailureReason.CONSENT_REQUIRED)
                attempt++
                delay(policy.delayMs(attempt))
                continue
            }
            if (rooted && (forceRestart || !backend.isServerRunning())) {
                backend.restartServer()
                forceRestart = false
            }

            val stream = backend.newStream()
            current = stream
            stream.onScreenInfo = { w, h, r -> onScreenInfo?.invoke(w, h, r) }
            val ended = CompletableDeferred<Boolean>()
            stream.onEnded = { early -> ended.complete(early) }

            if (!stream.connect()) {
                stream.disconnect()
                current = null
                report(CaptureFailureReason.SERVER_UNREACHABLE)
                attempt++
                if (rooted && attempt % 3 == 0) forceRestart = true
                delay(policy.delayMs(attempt))
                continue
            }

            attempt = 0
            val collector = scope.launch {
                stream.frames.collect { frame ->
                    lastReported = null
                    _frames.emit(frame)
                }
            }
            val early = try {
                ended.await()
            } finally {
                collector.cancel()
                stream.disconnect()
                if (current === stream) current = null
            }
            report(if (early) CaptureFailureReason.CAPTURE_SETUP_FAILED else CaptureFailureReason.SERVER_DIED)
            forceRestart = rooted
            attempt++
            delay(policy.delayMs(attempt))
        }
    }
}
