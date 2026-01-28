package com.androidremote.screenserver.wrappers

import android.annotation.SuppressLint
import android.graphics.Rect
import android.os.Build
import android.os.IBinder
import android.view.Surface
import java.lang.reflect.Method

/**
 * Reflection-based wrapper for android.view.SurfaceControl hidden API.
 *
 * This allows screen capture without MediaProjection (which requires user consent).
 * Must be run with shell permissions (via app_process).
 *
 * Based on scrcpy's SurfaceControl wrapper.
 */
@SuppressLint("PrivateApi", "DiscouragedPrivateApi")
object SurfaceControl {

    private val clazz: Class<*> = Class.forName("android.view.SurfaceControl")

    private var getBuiltInDisplayMethod: Method? = null
    private var getPhysicalDisplayTokenMethod: Method? = null
    private var getPhysicalDisplayIdsMethod: Method? = null

    fun openTransaction() {
        try {
            clazz.getMethod("openTransaction").invoke(null)
        } catch (e: Exception) {
            throw RuntimeException("Failed to open transaction", e)
        }
    }

    fun closeTransaction() {
        try {
            clazz.getMethod("closeTransaction").invoke(null)
        } catch (e: Exception) {
            throw RuntimeException("Failed to close transaction", e)
        }
    }

    fun setDisplayProjection(
        displayToken: IBinder,
        orientation: Int,
        layerStackRect: Rect,
        displayRect: Rect
    ) {
        try {
            clazz.getMethod(
                "setDisplayProjection",
                IBinder::class.java,
                Int::class.javaPrimitiveType,
                Rect::class.java,
                Rect::class.java
            ).invoke(null, displayToken, orientation, layerStackRect, displayRect)
        } catch (e: Exception) {
            throw RuntimeException("Failed to set display projection", e)
        }
    }

    fun setDisplayLayerStack(displayToken: IBinder, layerStack: Int) {
        try {
            clazz.getMethod(
                "setDisplayLayerStack",
                IBinder::class.java,
                Int::class.javaPrimitiveType
            ).invoke(null, displayToken, layerStack)
        } catch (e: Exception) {
            throw RuntimeException("Failed to set display layer stack", e)
        }
    }

    fun setDisplaySurface(displayToken: IBinder, surface: Surface) {
        try {
            clazz.getMethod(
                "setDisplaySurface",
                IBinder::class.java,
                Surface::class.java
            ).invoke(null, displayToken, surface)
        } catch (e: Exception) {
            throw RuntimeException("Failed to set display surface", e)
        }
    }

    fun createDisplay(name: String, secure: Boolean): IBinder {
        return try {
            clazz.getMethod(
                "createDisplay",
                String::class.java,
                Boolean::class.javaPrimitiveType
            ).invoke(null, name, secure) as IBinder
        } catch (e: Exception) {
            throw RuntimeException("Failed to create display", e)
        }
    }

    fun destroyDisplay(displayToken: IBinder) {
        try {
            clazz.getMethod("destroyDisplay", IBinder::class.java)
                .invoke(null, displayToken)
        } catch (e: Exception) {
            throw RuntimeException("Failed to destroy display", e)
        }
    }

    /**
     * Get the built-in display token.
     * API changed in Android 10.
     */
    fun getBuiltInDisplay(): IBinder? {
        return try {
            val method = getGetBuiltInDisplayMethod()
            if (Build.VERSION.SDK_INT < 29) {
                // Android 9 and below: getBuiltInDisplay(0)
                method.invoke(null, 0) as? IBinder
            } else {
                // Android 10+: getInternalDisplayToken()
                method.invoke(null) as? IBinder
            }
        } catch (e: Exception) {
            System.err.println("Could not get built-in display: ${e.message}")
            null
        }
    }

    private fun getGetBuiltInDisplayMethod(): Method {
        if (getBuiltInDisplayMethod == null) {
            getBuiltInDisplayMethod = if (Build.VERSION.SDK_INT < 29) {
                clazz.getMethod("getBuiltInDisplay", Int::class.javaPrimitiveType)
            } else {
                clazz.getMethod("getInternalDisplayToken")
            }
        }
        return getBuiltInDisplayMethod!!
    }

    fun getPhysicalDisplayToken(physicalDisplayId: Long): IBinder? {
        return try {
            if (getPhysicalDisplayTokenMethod == null) {
                getPhysicalDisplayTokenMethod = clazz.getMethod(
                    "getPhysicalDisplayToken",
                    Long::class.javaPrimitiveType
                )
            }
            getPhysicalDisplayTokenMethod!!.invoke(null, physicalDisplayId) as? IBinder
        } catch (e: Exception) {
            System.err.println("Could not get physical display token: ${e.message}")
            null
        }
    }

    fun getPhysicalDisplayIds(): LongArray? {
        return try {
            if (getPhysicalDisplayIdsMethod == null) {
                getPhysicalDisplayIdsMethod = clazz.getMethod("getPhysicalDisplayIds")
            }
            getPhysicalDisplayIdsMethod!!.invoke(null) as? LongArray
        } catch (e: Exception) {
            System.err.println("Could not get physical display IDs: ${e.message}")
            null
        }
    }

    /**
     * Check if createDisplay is available.
     * This method was removed in Android 15.
     */
    fun hasCreateDisplay(): Boolean {
        return try {
            clazz.getMethod(
                "createDisplay",
                String::class.java,
                Boolean::class.javaPrimitiveType
            )
            true
        } catch (e: NoSuchMethodException) {
            false
        }
    }
}
