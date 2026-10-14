package com.androidremote.app.service

import com.androidremote.app.controller.SessionState
import com.androidremote.transport.IceServerParser
import com.androidremote.transport.PeerConnectionConfig
import com.androidremote.transport.RemoteSession
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.isSuccess
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.asCoroutineDispatcher
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

enum class CaptureAction { NONE, START_CAPTURE, STOP_CAPTURE, STOP_CAPTURE_AND_SERVICE }

/**
 * Decides when RemoteSessionService starts and stops capture, from the session state stream.
 *
 * A `StateFlow` replays its current value to a new collector. If a second START_REMOTE arrives
 * while the first session is still `Connected`, that stale value must not start capture for the
 * new session (AR-15), so `Connected` only counts after a `Connecting` or `Reconnecting` was seen
 * since [beginSession]. Pure logic, no Android types.
 */
class CaptureCoordinator {
    private var autoStarted = false
    private var sawFreshSession = false
    private var capturing = false

    /** Begin tracking a new session. Returns STOP_CAPTURE when an older session's capture is still running. */
    fun beginSession(autoStarted: Boolean): CaptureAction {
        val wasCapturing = capturing
        this.autoStarted = autoStarted
        sawFreshSession = false
        capturing = false
        return if (wasCapturing) CaptureAction.STOP_CAPTURE else CaptureAction.NONE
    }

    /** The capture start did not work out; allow another attempt on the next Connected. */
    fun onCaptureStartFailed() {
        capturing = false
    }

    fun onState(state: SessionState): CaptureAction = when (state) {
        is SessionState.Connecting, is SessionState.Reconnecting -> {
            sawFreshSession = true
            CaptureAction.NONE
        }
        is SessionState.Connected -> {
            if (sawFreshSession && autoStarted && !capturing) {
                capturing = true
                CaptureAction.START_CAPTURE
            } else {
                CaptureAction.NONE
            }
        }
        is SessionState.Disconnected, is SessionState.Error -> {
            if (!sawFreshSession) {
                CaptureAction.NONE
            } else {
                val wasCapturing = capturing
                capturing = false
                when {
                    // Never leave a foreground "screen is being shared" service behind (AR-10).
                    autoStarted -> CaptureAction.STOP_CAPTURE_AND_SERVICE
                    wasCapturing -> CaptureAction.STOP_CAPTURE
                    else -> CaptureAction.NONE
                }
            }
        }
    }
}

/** A dedicated single-thread dispatcher for input and MDM execution (AR-06). */
class InputDispatcher private constructor(private val executor: ExecutorService) {
    val dispatcher: CoroutineDispatcher = executor.asCoroutineDispatcher()

    fun close() {
        executor.shutdownNow()
    }

    companion object {
        const val THREAD_NAME = "remote-input"

        fun create(): InputDispatcher = InputDispatcher(
            Executors.newSingleThreadExecutor { r -> Thread(r, THREAD_NAME).apply { isDaemon = true } }
        )
    }
}

/** Fetches `GET /api/ice-servers` (contract C7). The client must add the device token. */
object IceServersFetcher {
    suspend fun fetch(client: HttpClient, baseUrl: String): PeerConnectionConfig = try {
        val response = client.get(baseUrl.trimEnd('/') + "/api/ice-servers")
        if (response.status.isSuccess()) {
            IceServerParser.parseConfigFromString(response.bodyAsText())
        } else {
            RemoteSession.DEFAULT_CONFIG
        }
    } catch (e: kotlinx.coroutines.CancellationException) {
        throw e
    } catch (e: Exception) {
        RemoteSession.DEFAULT_CONFIG
    }
}
