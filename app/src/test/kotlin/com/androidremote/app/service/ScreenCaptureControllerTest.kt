package com.androidremote.app.service

import com.androidremote.transport.FrameData
import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import org.junit.jupiter.api.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ScreenCaptureControllerTest {

    private class FakeStream(val connectResults: ArrayDeque<Boolean>) : ScreenStream {
        override val frames = MutableSharedFlow<FrameData>(extraBufferCapacity = 8)
        override var onScreenInfo: ((Int, Int, Int) -> Unit)? = null
        override var onEnded: ((Boolean) -> Unit)? = null
        var keyFrameRequests = 0
        var disconnected = false
        override suspend fun connect(): Boolean = connectResults.removeFirstOrNull() ?: false
        override fun disconnect() { disconnected = true }
        override fun requestKeyFrame() { keyFrameRequests++ }
    }

    private class FakeBackend(
        var rooted: Boolean = true,
        var serverRunning: Boolean = false,
        val connectScript: ArrayDeque<Boolean> = ArrayDeque(),
    ) : CaptureBackend {
        val streams = mutableListOf<FakeStream>()
        var restarts = 0
        override suspend fun isRooted() = rooted
        override suspend fun isServerRunning() = serverRunning
        override suspend fun restartServer(): Boolean { restarts++; return true }
        override fun newStream(): ScreenStream = FakeStream(ArrayDeque(listOf(connectScript.removeFirstOrNull() ?: false))).also { streams += it }
    }

    private val policy = CaptureRetryPolicy(baseDelayMs = 1_000, maxDelayMs = 8_000)

    @Test
    fun `no working root fails fast with root_required and never retries`() = runTest {
        val backend = FakeBackend(rooted = false, serverRunning = true)
        val reasons = mutableListOf<String>()
        val c = ScreenCaptureController(this, backend, policy)
        c.onCaptureFailed = { reasons += it }
        c.start()
        runCurrent()
        assertThat(reasons).containsExactly("root_required")
        advanceTimeBy(120_000); runCurrent()
        assertThat(reasons).containsExactly("root_required")
        assertThat(backend.streams).isEmpty()
        assertThat(backend.restarts).isEqualTo(0)
        c.stop()
    }

    @Test
    fun `unreachable server reports once then retries with backoff while alive`() = runTest {
        val backend = FakeBackend(rooted = true)
        val reasons = mutableListOf<String>()
        val c = ScreenCaptureController(this, backend, policy)
        c.onCaptureFailed = { reasons += it }
        c.start()
        runCurrent()
        assertThat(backend.streams).hasSize(1)
        assertThat(reasons).containsExactly("screen_server_unreachable")
        advanceTimeBy(1_001); runCurrent()
        assertThat(backend.streams).hasSize(2)
        advanceTimeBy(2_001); runCurrent()
        assertThat(backend.streams).hasSize(3)
        // same reason is not repeated
        assertThat(reasons).containsExactly("screen_server_unreachable")
        c.stop()
        advanceTimeBy(60_000); runCurrent()
        assertThat(backend.streams).hasSize(3)
    }

    @Test
    fun `recovers when the server finally answers and forwards screen info and frames`() = runTest {
        val backend = FakeBackend(rooted = true, connectScript = ArrayDeque(listOf(false, true)))
        val infos = mutableListOf<Triple<Int, Int, Int>>()
        val got = mutableListOf<FrameData>()
        val c = ScreenCaptureController(this, backend, policy)
        c.onScreenInfo = { w, h, r -> infos += Triple(w, h, r) }
        val collector = launch { c.frames.collect { got += it } }
        c.start()
        runCurrent()
        advanceTimeBy(1_001); runCurrent()
        val live = backend.streams[1]
        live.onScreenInfo!!.invoke(1080, 2400, 0)
        live.frames.emit(FrameData(byteArrayOf(1), 1L, true))
        runCurrent()
        assertThat(infos).containsExactly(Triple(1080, 2400, 0))
        assertThat(got).hasSize(1)
        c.requestKeyFrame()
        assertThat(live.keyFrameRequests).isEqualTo(1)
        c.stop()
        assertThat(live.disconnected).isTrue()
        collector.cancel()
    }

    @Test
    fun `stream dying before any frame reports capture_setup_failed and restarts the server`() = runTest {
        val backend = FakeBackend(rooted = true, connectScript = ArrayDeque(listOf(true, true)))
        val reasons = mutableListOf<String>()
        val c = ScreenCaptureController(this, backend, policy)
        c.onCaptureFailed = { reasons += it }
        c.start()
        runCurrent()
        val restartsBefore = backend.restarts
        backend.streams[0].onEnded!!.invoke(true)
        runCurrent()
        assertThat(reasons).containsExactly("capture_setup_failed")
        advanceTimeBy(1_001); runCurrent()
        assertThat(backend.streams).hasSize(2)
        assertThat(backend.restarts).isGreaterThan(restartsBefore)
        c.stop()
    }

    @Test
    fun `requestKeyFrame without a live stream is a no-op`() = runTest {
        val c = ScreenCaptureController(this, FakeBackend(), policy)
        c.requestKeyFrame()
    }
}
