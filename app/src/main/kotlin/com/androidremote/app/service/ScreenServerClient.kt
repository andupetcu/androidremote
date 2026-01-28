package com.androidremote.app.service

import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.util.Log
import com.androidremote.transport.FrameData
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.DataInputStream
import java.io.IOException
import java.nio.ByteBuffer

/**
 * Client that connects to the screen-server running via app_process
 * and receives H.264 frames to relay over WebRTC.
 *
 * The screen-server is started separately via:
 *   adb shell CLASSPATH=/data/local/tmp/screen-server.apk \
 *     app_process / com.androidremote.screenserver.Server
 */
class ScreenServerClient(
    private val socketName: String = "android-remote-video",
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.IO)
) {
    companion object {
        private const val TAG = "ScreenServerClient"
        private const val MAX_RECONNECT_ATTEMPTS = 5
        private const val RECONNECT_DELAY_MS = 1000L

        // Frame flags
        private const val FLAG_KEY_FRAME = 0x01
        private const val FLAG_CONFIG = 0x02
    }

    private var socket: LocalSocket? = null
    private var readJob: Job? = null
    private var reconnectAttempts = 0

    private val _frames = MutableSharedFlow<FrameData>(
        replay = 0,
        extraBufferCapacity = 2
    )

    /**
     * Flow of decoded frames from the screen server.
     */
    val frames: SharedFlow<FrameData> = _frames.asSharedFlow()

    private var _videoWidth = 0
    private var _videoHeight = 0

    /**
     * Video dimensions (available after connection).
     */
    val videoWidth: Int get() = _videoWidth
    val videoHeight: Int get() = _videoHeight

    private var _isConnected = false
    val isConnected: Boolean get() = _isConnected

    /**
     * Connect to the screen server and start receiving frames.
     */
    suspend fun connect(): Boolean {
        return withContext(Dispatchers.IO) {
            try {
                val newSocket = LocalSocket()
                newSocket.connect(LocalSocketAddress(socketName, LocalSocketAddress.Namespace.ABSTRACT))

                // Read header (video dimensions)
                val input = DataInputStream(newSocket.inputStream)
                _videoWidth = input.readInt()
                _videoHeight = input.readInt()

                Log.i(TAG, "Connected to screen server: ${_videoWidth}x${_videoHeight}")

                socket = newSocket
                _isConnected = true
                reconnectAttempts = 0

                // Start reading frames
                readJob = scope.launch {
                    readFrames(input)
                }

                true
            } catch (e: IOException) {
                Log.e(TAG, "Failed to connect to screen server: ${e.message}")
                _isConnected = false
                false
            }
        }
    }

    /**
     * Disconnect from the screen server.
     */
    fun disconnect() {
        readJob?.cancel()
        readJob = null

        try {
            socket?.close()
        } catch (e: IOException) {
            // Ignore
        }
        socket = null
        _isConnected = false
    }

    /**
     * Try to reconnect to the screen server.
     */
    suspend fun reconnect(): Boolean {
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            Log.e(TAG, "Max reconnect attempts reached")
            return false
        }

        reconnectAttempts++
        Log.i(TAG, "Reconnecting (attempt $reconnectAttempts/$MAX_RECONNECT_ATTEMPTS)")

        disconnect()
        delay(RECONNECT_DELAY_MS * reconnectAttempts) // Exponential backoff
        return connect()
    }

    private suspend fun readFrames(input: DataInputStream) {
        val buffer = ByteArray(1024 * 1024) // 1MB buffer for frames

        try {
            while (scope.isActive && _isConnected) {
                // Read packet header: [size:4][flags:1]
                val size = input.readInt()
                val flags = input.readByte().toInt() and 0xFF

                if (size <= 0 || size > buffer.size) {
                    Log.e(TAG, "Invalid frame size: $size")
                    break
                }

                // Read frame data
                input.readFully(buffer, 0, size)

                val isKeyFrame = (flags and FLAG_KEY_FRAME) != 0
                val isConfig = (flags and FLAG_CONFIG) != 0

                if (isConfig) {
                    Log.d(TAG, "Received codec config ($size bytes)")
                } else {
                    Log.v(TAG, "Received frame ($size bytes, keyFrame=$isKeyFrame)")
                }

                // Emit frame
                val frameData = FrameData(
                    data = buffer.copyOf(size),
                    presentationTimeUs = System.nanoTime() / 1000,
                    isKeyFrame = isKeyFrame || isConfig
                )

                _frames.emit(frameData)
            }
        } catch (e: IOException) {
            if (_isConnected) {
                Log.e(TAG, "Error reading frames: ${e.message}")
                _isConnected = false

                // Try to reconnect
                scope.launch {
                    reconnect()
                }
            }
        }
    }
}
