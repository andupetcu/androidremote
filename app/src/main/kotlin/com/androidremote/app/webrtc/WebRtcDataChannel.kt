package com.androidremote.app.webrtc

import com.androidremote.transport.DataChannelInterface
import com.androidremote.transport.DataChannelObserver
import com.androidremote.transport.DataChannelState
import org.webrtc.DataChannel
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets

/**
 * Wrapper around org.webrtc.DataChannel that implements DataChannelInterface.
 *
 * Provides conversion between WebRTC types and our domain types.
 */
class WebRtcDataChannel(
    private val nativeChannel: DataChannel
) : DataChannelInterface {

    private var observer: DataChannelObserver? = null
    private var registeredObserver: DataChannel.Observer? = null

    override val label: String
        get() = nativeChannel.label()

    override val state: DataChannelState
        get() = mapDataChannelState(nativeChannel.state())

    override fun send(data: ByteArray): Boolean {
        val buffer = DataChannel.Buffer(ByteBuffer.wrap(data), true)
        return nativeChannel.send(buffer)
    }

    override fun send(text: String): Boolean {
        val bytes = text.toByteArray(StandardCharsets.UTF_8)
        val buffer = DataChannel.Buffer(ByteBuffer.wrap(bytes), false)
        return nativeChannel.send(buffer)
    }

    override fun close() {
        registeredObserver?.let { nativeChannel.unregisterObserver() }
        registeredObserver = null
        observer = null
        nativeChannel.close()
    }

    override fun setObserver(observer: DataChannelObserver) {
        // Unregister any existing observer first to prevent memory leaks
        registeredObserver?.let { nativeChannel.unregisterObserver() }

        this.observer = observer
        val webrtcObserver = WebRtcDataChannelObserver(observer)
        registeredObserver = webrtcObserver
        nativeChannel.registerObserver(webrtcObserver)
    }

    /**
     * Maps WebRTC DataChannel.State to our DataChannelState.
     */
    private fun mapDataChannelState(state: DataChannel.State): DataChannelState {
        return when (state) {
            DataChannel.State.CONNECTING -> DataChannelState.CONNECTING
            DataChannel.State.OPEN -> DataChannelState.OPEN
            DataChannel.State.CLOSING -> DataChannelState.CLOSING
            DataChannel.State.CLOSED -> DataChannelState.CLOSED
        }
    }

    /**
     * Internal observer that bridges WebRTC callbacks to our DataChannelObserver.
     */
    private inner class WebRtcDataChannelObserver(
        private val observer: DataChannelObserver
    ) : DataChannel.Observer {

        override fun onStateChange() {
            observer.onStateChange(mapDataChannelState(nativeChannel.state()))
        }

        override fun onMessage(buffer: DataChannel.Buffer) {
            val data = buffer.data
            val bytes = ByteArray(data.remaining())
            data.get(bytes)

            if (buffer.binary) {
                observer.onMessage(bytes)
            } else {
                observer.onMessage(String(bytes, StandardCharsets.UTF_8))
            }
        }

        override fun onBufferedAmountChange(previousAmount: Long) {
            // Not exposed in our interface - could be added if needed
        }
    }

    companion object {
        /**
         * Maps our DataChannelState to WebRTC DataChannel.State.
         * Useful for testing and state comparison.
         */
        fun toWebRtcState(state: DataChannelState): DataChannel.State {
            return when (state) {
                DataChannelState.CONNECTING -> DataChannel.State.CONNECTING
                DataChannelState.OPEN -> DataChannel.State.OPEN
                DataChannelState.CLOSING -> DataChannel.State.CLOSING
                DataChannelState.CLOSED -> DataChannel.State.CLOSED
            }
        }
    }
}
