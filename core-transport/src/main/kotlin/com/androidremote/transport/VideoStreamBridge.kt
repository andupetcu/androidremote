package com.androidremote.transport

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Data class representing a video frame to be transmitted.
 *
 * This is transport-layer agnostic and can be mapped from encoder-specific
 * frame types like EncodedFrame.
 *
 * @property data Raw encoded H.264 data (NAL units)
 * @property presentationTimeUs Presentation timestamp in microseconds
 * @property isKeyFrame True if this is an I-frame (keyframe)
 */
data class FrameData(
    val data: ByteArray,
    val presentationTimeUs: Long,
    val isKeyFrame: Boolean
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (javaClass != other?.javaClass) return false
        other as FrameData
        return data.contentEquals(other.data) &&
            presentationTimeUs == other.presentationTimeUs &&
            isKeyFrame == other.isKeyFrame
    }

    override fun hashCode(): Int {
        var result = data.contentHashCode()
        result = 31 * result + presentationTimeUs.hashCode()
        result = 31 * result + isKeyFrame.hashCode()
        return result
    }
}

/**
 * Bridge that connects an encoded frame flow to a video channel.
 *
 * Collects frames from the SharedFlow and sends them over the VideoChannel.
 * Handles the frame collection lifecycle with start/stop.
 *
 * @param videoChannel Channel for sending frames over WebRTC data channel
 * @param framesFlow Flow of encoded frames to transmit
 * @param scope CoroutineScope for frame collection coroutine
 */
class VideoStreamBridge(
    private val videoChannel: VideoChannel,
    private val framesFlow: SharedFlow<FrameData>,
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.Default)
) {
    private var collectionJob: Job? = null
    private val running = AtomicBoolean(false)

    /**
     * True if the bridge is actively collecting and sending frames.
     */
    val isRunning: Boolean
        get() = running.get()

    /**
     * Start collecting frames and sending them over the channel.
     *
     * Does nothing if already running.
     */
    fun start() {
        if (running.getAndSet(true)) return

        collectionJob = scope.launch {
            framesFlow.collect { frame ->
                if (!running.get()) return@collect

                // Check if channel is still open before sending
                if (!videoChannel.isOpen) {
                    stop()
                    return@collect
                }

                try {
                    videoChannel.sendFrame(
                        data = frame.data,
                        presentationTimeUs = frame.presentationTimeUs,
                        isKeyFrame = frame.isKeyFrame
                    )
                } catch (e: Exception) {
                    // Channel may have closed between check and send
                    stop()
                    return@collect
                }
            }
        }
    }

    /**
     * Stop collecting and sending frames.
     *
     * Does nothing if not running.
     */
    fun stop() {
        if (!running.getAndSet(false)) return

        collectionJob?.cancel()
        collectionJob = null
    }
}
