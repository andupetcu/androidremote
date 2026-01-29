package com.androidremote.screenserver.video

import android.graphics.Rect
import android.hardware.display.VirtualDisplay
import android.os.Build
import android.os.IBinder
import android.view.Surface
import com.androidremote.screenserver.wrappers.DisplayInfo
import com.androidremote.screenserver.wrappers.DisplayManager
import com.androidremote.screenserver.wrappers.SurfaceControl

/**
 * Screen capture using SurfaceControl or DisplayManager.
 *
 * Based on scrcpy's ScreenCapture.java - tries DisplayManager first,
 * then falls back to SurfaceControl.
 */
class ScreenCapture(
    private val displayId: Int,
    private var maxSize: Int
) {
    private var displayInfo: DisplayInfo? = null
    private var videoSize: Size? = null
    private var display: IBinder? = null
    private var virtualDisplay: VirtualDisplay? = null

    /**
     * Get the video output size.
     */
    fun getSize(): Size = videoSize ?: throw IllegalStateException("Not prepared")

    /**
     * Prepare the capture by reading display info and calculating video size.
     */
    fun prepare() {
        displayInfo = DisplayInfo.getDisplayInfo(displayId)
        val info = displayInfo!!

        if ((info.flags and DisplayInfo.FLAG_SUPPORTS_PROTECTED_BUFFERS) == 0) {
            System.err.println("WARN: Display doesn't have FLAG_SUPPORTS_PROTECTED_BUFFERS")
        }

        // Calculate video size respecting maxSize constraint
        val displaySize = Size(info.width, info.height)
        videoSize = displaySize.limit(maxSize).round8()

        System.err.println("Display size: ${info.width}x${info.height}")
        System.err.println("Video size: ${videoSize!!.width}x${videoSize!!.height}")
    }

    /**
     * Start capturing to the given Surface.
     */
    fun start(surface: Surface) {
        val info = displayInfo ?: throw IllegalStateException("Not prepared")
        val size = videoSize ?: throw IllegalStateException("Not prepared")

        // Clean up any existing capture
        release()

        System.err.println("Process UID: ${android.os.Process.myUid()}, PID: ${android.os.Process.myPid()}")

        // Try DisplayManager first (Android 15+)
        try {
            val dm = DisplayManager.create()
            virtualDisplay = dm.createVirtualDisplay(
                "android-remote",
                size.width,
                size.height,
                displayId,
                surface
            )
            System.err.println("Display: using DisplayManager API")
            return
        } catch (e: Exception) {
            System.err.println("DisplayManager failed: ${e.message}")
            e.printStackTrace(System.err)
        }

        // Fall back to SurfaceControl
        try {
            display = createDisplay()
            setDisplaySurface(
                display!!,
                surface,
                Rect(0, 0, info.width, info.height),
                Rect(0, 0, size.width, size.height),
                info.layerStack
            )
            System.err.println("Display: using SurfaceControl API")
        } catch (e: Exception) {
            System.err.println("SurfaceControl failed: ${e.message}")
            e.printStackTrace(System.err)
            throw RuntimeException("Could not create display capture (UID=${android.os.Process.myUid()})", e)
        }
    }

    /**
     * Release all resources.
     */
    fun release() {
        display?.let {
            try {
                SurfaceControl.destroyDisplay(it)
            } catch (e: Exception) {
                System.err.println("Error destroying display: ${e.message}")
            }
            display = null
        }

        virtualDisplay?.let {
            it.release()
            virtualDisplay = null
        }
    }

    /**
     * Update the max size (for retry with smaller resolution).
     */
    fun setMaxSize(newMaxSize: Int): Boolean {
        maxSize = newMaxSize
        return true
    }

    private fun createDisplay(): IBinder {
        // Since Android 12, secure displays cannot be created with shell permissions
        val secure = Build.VERSION.SDK_INT < 30 ||
                (Build.VERSION.SDK_INT == 30 && "S" != Build.VERSION.CODENAME)
        return SurfaceControl.createDisplay("android-remote", secure)
    }

    private fun setDisplaySurface(
        display: IBinder,
        surface: Surface,
        deviceRect: Rect,
        displayRect: Rect,
        layerStack: Int
    ) {
        SurfaceControl.openTransaction()
        try {
            SurfaceControl.setDisplaySurface(display, surface)
            SurfaceControl.setDisplayProjection(display, 0, deviceRect, displayRect)
            SurfaceControl.setDisplayLayerStack(display, layerStack)
        } finally {
            SurfaceControl.closeTransaction()
        }
    }
}

/**
 * Simple size class.
 */
data class Size(val width: Int, val height: Int) {
    /**
     * Limit the size so the max dimension is at most maxSize.
     */
    fun limit(maxSize: Int): Size {
        if (maxSize <= 0 || (width <= maxSize && height <= maxSize)) {
            return this
        }
        return if (width > height) {
            val newWidth = maxSize
            val newHeight = (height.toLong() * maxSize / width).toInt()
            Size(newWidth, newHeight)
        } else {
            val newHeight = maxSize
            val newWidth = (width.toLong() * maxSize / height).toInt()
            Size(newWidth, newHeight)
        }
    }

    /**
     * Round dimensions to multiples of 8 (required by many encoders).
     */
    fun round8(): Size {
        return Size(
            (width + 7) and 7.inv(),
            (height + 7) and 7.inv()
        )
    }

    fun toRect(): Rect = Rect(0, 0, width, height)
}
