package com.androidremote.screenserver

import android.net.LocalServerSocket
import android.net.LocalSocket
import android.os.Looper
import com.androidremote.screenserver.video.ScreenCapture
import com.androidremote.screenserver.video.SurfaceEncoder
import kotlin.system.exitProcess

/**
 * Main entry point for the screen capture server.
 *
 * Run via app_process:
 *   adb shell CLASSPATH=/data/local/tmp/screen-server.apk \
 *     app_process / com.androidremote.screenserver.Server [options]
 *
 * Options:
 *   -n <name>     Socket name (default: android-remote-video)
 *   -d <id>       Display ID (default: 0)
 *   -m <size>     Max video dimension (default: 1920)
 *   -b <rate>     Bitrate in bps (default: 8000000)
 *   -f <fps>      Max FPS (default: 60)
 *   -h            Show help
 */
object Server {

    @JvmStatic
    fun main(args: Array<String>) {
        // Prepare looper (required for some devices)
        Looper.prepareMainLooper()

        val params = parseArgs(args)
        if (params.showHelp) {
            printHelp()
            exitProcess(0)
        }

        System.err.println("PID: ${android.os.Process.myPid()}")
        System.err.println("Display: ${params.displayId}")
        System.err.println("Max size: ${params.maxSize}")
        System.err.println("Capture size: ${params.captureSize}")
        System.err.println("Bitrate: ${params.bitRate}")
        System.err.println("Max FPS: ${params.maxFps}")
        System.err.println("Socket: ${params.socketName}")

        try {
            startServer(params)
        } catch (e: Exception) {
            System.err.println("Server error: ${e.message}")
            e.printStackTrace(System.err)
            exitProcess(1)
        }
    }

    private fun startServer(params: Params) {
        val serverSocket = LocalServerSocket(params.socketName)
        System.err.println("Listening on socket: ${params.socketName}")

        // Accept connections in a loop — each client gets exclusive capture.
        // When one client disconnects, the server waits for the next.
        while (true) {
            val clientSocket = serverSocket.accept()
            System.err.println("Client connected")

            try {
                runCapture(clientSocket, params)
            } catch (e: Exception) {
                System.err.println("Capture session ended: ${e.message}")
            } finally {
                try { clientSocket.close() } catch (_: Exception) {}
            }

            System.err.println("Client disconnected, waiting for next connection...")
        }
    }

    private fun runCapture(socket: LocalSocket, params: Params) {
        val capture = ScreenCapture(params.displayId, params.maxSize, params.captureSize)
        val encoder = SurfaceEncoder(
            capture = capture,
            output = socket.outputStream,
            bitRate = params.bitRate,
            maxFps = params.maxFps
        )

        // Handle SIGTERM/SIGINT
        Runtime.getRuntime().addShutdownHook(Thread {
            System.err.println("Shutting down...")
            encoder.stop()
        })

        encoder.encode()
        System.err.println("Encoding finished")
    }

    private fun parseArgs(args: Array<String>): Params {
        var socketName = "android-remote-video"
        var displayId = 0
        var maxSize = 1920
        var captureSize = 0
        var bitRate = 8_000_000
        var maxFps = 60f
        var showHelp = false

        var i = 0
        while (i < args.size) {
            when (args[i]) {
                "-n" -> {
                    socketName = args.getOrNull(++i) ?: socketName
                }
                "-d" -> {
                    displayId = args.getOrNull(++i)?.toIntOrNull() ?: displayId
                }
                "-m" -> {
                    maxSize = args.getOrNull(++i)?.toIntOrNull() ?: maxSize
                }
                "-c" -> {
                    captureSize = args.getOrNull(++i)?.toIntOrNull() ?: captureSize
                }
                "-b" -> {
                    bitRate = args.getOrNull(++i)?.toIntOrNull() ?: bitRate
                }
                "-f" -> {
                    maxFps = args.getOrNull(++i)?.toFloatOrNull() ?: maxFps
                }
                "-h", "--help" -> {
                    showHelp = true
                }
            }
            i++
        }

        return Params(socketName, displayId, maxSize, captureSize, bitRate, maxFps, showHelp)
    }

    private fun printHelp() {
        println("""
            Android Remote Screen Server

            Usage: app_process / com.androidremote.screenserver.Server [options]

            Options:
              -n <name>     Socket name (default: android-remote-video)
              -d <id>       Display ID (default: 0)
              -m <size>     Max video dimension (default: 1920)
              -c <size>     Capture rect size override (default: auto-detect)
              -b <rate>     Bitrate in bps (default: 8000000)
              -f <fps>      Max FPS (default: 60)
              -h            Show this help

            Example:
              adb shell CLASSPATH=/data/local/tmp/screen-server.apk \
                app_process / com.androidremote.screenserver.Server -m 1280 -b 4000000
        """.trimIndent())
    }

    private data class Params(
        val socketName: String,
        val displayId: Int,
        val maxSize: Int,
        val captureSize: Int,
        val bitRate: Int,
        val maxFps: Float,
        val showHelp: Boolean
    )
}
