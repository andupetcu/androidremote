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
) : ScreenStream {
    companion object {
        private const val TAG = "ScreenServerClient"
        private const val MAX_RECONNECT_ATTEMPTS = 5
        private const val RECONNECT_DELAY_MS = 1000L

        /**
         * Timeout for the initial header read after connecting.
         * If the screen server doesn't send the header (dimensions) within this time,
         * the connection is considered failed. This prevents hanging when the server
         * process is stuck in an old capture session.
         */
        private const val CONNECT_TIMEOUT_MS = 5_000

    }

    private var socket: LocalSocket? = null
    private var readJob: Job? = null
    private var reconnectAttempts = 0
    private var firstFrameReceived = false

    /**
     * Callback invoked when the server connection dies before any frames arrive.
     * This indicates the screen server crashed during capture setup (e.g. permission issue).
     */
    var onEarlyDeath: (() -> Unit)? = null

    /** Rotation / size announcements from the server (also sent once at start). */
    override var onScreenInfo: ((Int, Int, Int) -> Unit)? = null

    /**
     * When set, the client does NOT reconnect by itself: it reports the end of the stream here
     * and the owner (ScreenCaptureController) decides how to retry.
     */
    override var onEnded: ((early: Boolean) -> Unit)? = null

    private val _frames = MutableSharedFlow<FrameData>(
        replay = 0,
        extraBufferCapacity = 2
    )

    /**
     * Flow of decoded frames from the screen server.
     */
    override val frames: SharedFlow<FrameData> = _frames.asSharedFlow()

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
    override suspend fun connect(): Boolean {
        return withContext(Dispatchers.IO) {
            try {
                val newSocket = LocalSocket()
                newSocket.connect(LocalSocketAddress(socketName, LocalSocketAddress.Namespace.ABSTRACT))

                // AR-08: abstract sockets are world-connectable, so another app could have
                // bound the name first. Only talk to a server running as shell/root/us.
                val serverUid = try { newSocket.peerCredentials?.uid } catch (e: IOException) { null }
                if (!ScreenServerPeer.isTrustedServerUid(serverUid, android.os.Process.myUid())) {
                    Log.e(TAG, "Refusing screen server with unexpected uid=$serverUid")
                    try { newSocket.close() } catch (_: IOException) {}
                    _isConnected = false
                    return@withContext false
                }

                // Set a timeout for the initial header read to prevent hanging
                // when the server process is stuck in an old capture session
                newSocket.soTimeout = CONNECT_TIMEOUT_MS

                // Read header (video dimensions)
                val input = DataInputStream(newSocket.inputStream)
                _videoWidth = input.readInt()
                _videoHeight = input.readInt()

                Log.i(TAG, "Connected to screen server: ${_videoWidth}x${_videoHeight}")

                // Reset timeout — frame reads can take longer (encoder may be idle)
                newSocket.soTimeout = 0

                socket = newSocket
                firstFrameReceived = false
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
    override fun disconnect() {
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

    /**
     * Ask the screen-server's encoder for a sync frame (keyframe on demand).
     * Fire-and-forget; failures only mean the connection is already going away.
     */
    override fun requestKeyFrame() {
        val out = try { socket?.outputStream } catch (e: IOException) { null } ?: return
        scope.launch(Dispatchers.IO) {
            try {
                synchronized(out) {
                    out.write(ScreenControl.requestSyncFrame())
                    out.flush()
                }
            } catch (e: IOException) {
                Log.w(TAG, "requestKeyFrame failed: ${e.message}")
            }
        }
    }

    private suspend fun readFrames(input: DataInputStream) {
        val reader = FrameReader(input)

        try {
            while (scope.isActive && _isConnected) {
                when (val packet = reader.next()) {
                    is ScreenPacket.Info -> {
                        _videoWidth = packet.width
                        _videoHeight = packet.height
                        Log.i(TAG, "Screen info: ${packet.width}x${packet.height} rot=${packet.rotation}")
                        onScreenInfo?.invoke(packet.width, packet.height, packet.rotation)
                    }
                    is ScreenPacket.Skipped -> {
                        // AR-11: never end the stream for one big frame; ask for a fresh keyframe.
                        Log.w(TAG, "Skipped oversized frame (${packet.size} bytes)")
                        requestKeyFrame()
                    }
                    is ScreenPacket.Frame -> {
                        if (!firstFrameReceived) {
                            firstFrameReceived = true
                            Log.i(TAG, "First frame received (${packet.data.size} bytes, config=${packet.isConfig}, keyFrame=${packet.isKeyFrame})")
                        }
                        _frames.emit(
                            FrameData(
                                data = packet.data,
                                presentationTimeUs = System.nanoTime() / 1000,
                                isKeyFrame = packet.isKeyFrame || packet.isConfig
                            )
                        )
                    }
                }
            }
        } catch (e: IOException) {
            if (_isConnected) {
                Log.e(TAG, "Error reading frames: ${e.message}")
                _isConnected = false
                val early = !firstFrameReceived

                val ended = onEnded
                if (ended != null) {
                    ended(early)
                } else if (early) {
                    // Server died before sending any frames — likely a permission/capture issue
                    Log.e(TAG, "Screen server died before sending any frames (capture setup failed)")
                    onEarlyDeath?.invoke()
                } else {
                    // Try to reconnect
                    scope.launch {
                        reconnect()
                    }
                }
            }
        }
    }
}
