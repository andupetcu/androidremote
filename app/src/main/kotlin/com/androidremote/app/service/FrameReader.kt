package com.androidremote.app.service

import java.io.DataInputStream
import java.io.IOException

/** The stream from the screen-server is corrupt; the connection must be dropped and re-established. */
class FrameProtocolException(message: String) : IOException(message)

sealed class ScreenPacket {
    class Frame(val data: ByteArray, private val flags: Int) : ScreenPacket() {
        val isKeyFrame: Boolean get() = (flags and FrameReader.FLAG_KEY_FRAME) != 0
        val isConfig: Boolean get() = (flags and FrameReader.FLAG_CONFIG) != 0
    }

    /** A frame above the size cap. Its bytes were consumed; the stream is still in sync. */
    class Skipped(val size: Int, private val flags: Int) : ScreenPacket() {
        val wasKeyFrame: Boolean get() = (flags and (FrameReader.FLAG_KEY_FRAME or FrameReader.FLAG_CONFIG)) != 0
    }

    class Info(val width: Int, val height: Int, val rotation: Int) : ScreenPacket()
}

/**
 * Reads the screen-server packet stream: [size:4][flags:1][payload:size] (AR-11, AR-14).
 *
 * - Payloads are allocated per frame, so there is no fixed buffer to overflow.
 * - A frame larger than [maxFrameBytes] is skipped (consumed and reported), not fatal.
 * - A non-positive size, or one beyond [HARD_CAP_BYTES], means the stream is out of sync
 *   and raises [FrameProtocolException]; the caller reconnects.
 */
class FrameReader(
    private val input: DataInputStream,
    private val maxFrameBytes: Int = DEFAULT_MAX_FRAME_BYTES,
) {
    companion object {
        const val FLAG_KEY_FRAME = 0x01
        const val FLAG_CONFIG = 0x02
        const val FLAG_SCREEN_INFO = 0x04
        const val DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024
        /** Beyond this the length field is garbage, not a big frame. */
        const val HARD_CAP_BYTES = 64 * 1024 * 1024
        private const val SCREEN_INFO_BYTES = 12
    }

    /** Blocks for the next packet. Throws [java.io.EOFException] / [IOException] when the stream ends. */
    fun next(): ScreenPacket {
        val size = input.readInt()
        val flags = input.readByte().toInt() and 0xFF

        if (size <= 0 || size > HARD_CAP_BYTES) {
            throw FrameProtocolException("Invalid frame size: $size")
        }

        if ((flags and FLAG_SCREEN_INFO) != 0) {
            if (size != SCREEN_INFO_BYTES) throw FrameProtocolException("Bad screen info size: $size")
            return ScreenPacket.Info(input.readInt(), input.readInt(), input.readInt())
        }

        if (size > maxFrameBytes) {
            skipFully(size)
            return ScreenPacket.Skipped(size, flags)
        }

        val data = ByteArray(size)
        input.readFully(data)
        return ScreenPacket.Frame(data, flags)
    }

    private fun skipFully(count: Int) {
        var left = count
        while (left > 0) {
            val skipped = input.skipBytes(left)
            if (skipped <= 0) {
                input.readByte() // forces EOFException at end of stream
                left--
            } else {
                left -= skipped
            }
        }
    }
}

/** App -> screen-server control bytes (mirror of the server's ScreenProtocol). */
object ScreenControl {
    private const val REQUEST_SYNC_FRAME: Byte = 0x01

    fun requestSyncFrame(): ByteArray = byteArrayOf(REQUEST_SYNC_FRAME)
}
