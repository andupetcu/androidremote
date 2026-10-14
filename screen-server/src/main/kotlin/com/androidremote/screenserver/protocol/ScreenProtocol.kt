package com.androidremote.screenserver.protocol

import java.nio.ByteBuffer

/**
 * Wire format of the local-socket stream between the screen-server and the app.
 *
 * server -> app:
 *   header  : [width:4][height:4]                    (once, at connect)
 *   packets : [size:4][flags:1][payload:size]
 *     flags 0x01 key frame, 0x02 codec config, 0x04 screen info
 *     screen info payload = [width:4][height:4][rotationDegrees:4]
 *
 * app -> server: single control bytes, see [CONTROL_REQUEST_SYNC_FRAME].
 *
 * Pure Kotlin so it can be unit-tested on the JVM. The app has its own mirror
 * (FrameReader / ScreenControl); keep the constants in sync.
 */
object ScreenProtocol {
    const val FLAG_KEY_FRAME = 0x01
    const val FLAG_CONFIG = 0x02
    const val FLAG_SCREEN_INFO = 0x04

    /** Client asks the encoder for an IDR (MediaCodec PARAMETER_KEY_REQUEST_SYNC_FRAME). */
    const val CONTROL_REQUEST_SYNC_FRAME = 0x01

    fun isRequestSyncFrame(b: Int): Boolean = b == CONTROL_REQUEST_SYNC_FRAME

    fun encodePacket(flags: Int, data: ByteArray): ByteArray {
        val packet = ByteBuffer.allocate(5 + data.size)
        packet.putInt(data.size)
        packet.put(flags.toByte())
        packet.put(data)
        return packet.array()
    }

    fun encodeScreenInfo(width: Int, height: Int, rotationDegrees: Int): ByteArray {
        val payload = ByteBuffer.allocate(12).putInt(width).putInt(height).putInt(rotationDegrees).array()
        return encodePacket(FLAG_SCREEN_INFO, payload)
    }

    /** Surface.ROTATION_* constant -> degrees. Unknown values map to 0. */
    fun rotationDegrees(surfaceRotation: Int): Int = when (surfaceRotation) {
        1 -> 90
        2 -> 180
        3 -> 270
        else -> 0
    }
}

data class DisplayState(val width: Int, val height: Int, val rotation: Int)

object DisplayChangeDetector {
    fun hasChanged(previous: DisplayState, current: DisplayState): Boolean = previous != current
}

/**
 * Registers a single JVM shutdown hook no matter how many encoders come and go,
 * and stops only the encoder that is current at shutdown (AR-19).
 */
class StopHook(private val install: (Runnable) -> Unit) {
    @Volatile private var current: (() -> Unit)? = null
    private var installed = false

    @Synchronized
    fun track(stop: () -> Unit) {
        current = stop
        if (!installed) {
            installed = true
            install(Runnable { current?.invoke() })
        }
    }
}
