package com.androidremote.screenserver.wrappers

import android.annotation.SuppressLint
import android.hardware.display.VirtualDisplay
import android.os.IInterface
import android.view.Surface
import java.lang.reflect.Method

/**
 * Reflection-based wrapper for creating virtual displays via IDisplayManager.
 *
 * This is the fallback method for Android 15+ where SurfaceControl.createDisplay
 * is no longer available.
 *
 * Based on minicap's experimental DisplayManager wrapper.
 */
@SuppressLint("PrivateApi", "DiscouragedPrivateApi")
class DisplayManager private constructor(
    private val manager: IInterface
) {
    companion object {
        private const val VIRTUAL_DISPLAY_FLAG_PUBLIC = 1 shl 0
        private const val VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY = 1 shl 3
        private const val VIRTUAL_DISPLAY_FLAG_DESTROY_CONTENT_ON_REMOVAL = 1 shl 8

        private var createVirtualDisplayMethod: Method? = null

        /**
         * Create a DisplayManager instance using ServiceManager.
         */
        fun create(): DisplayManager {
            val serviceManager = Class.forName("android.os.ServiceManager")
            val getService = serviceManager.getMethod("getService", String::class.java)
            val displayBinder = getService.invoke(null, "display")
                ?: throw RuntimeException("Could not get display service")

            val iDisplayManager = Class.forName("android.hardware.display.IDisplayManager")
            val stub = Class.forName("android.hardware.display.IDisplayManager\$Stub")
            val asInterface = stub.getMethod("asInterface", android.os.IBinder::class.java)

            val manager = asInterface.invoke(null, displayBinder) as IInterface
            return DisplayManager(manager)
        }
    }

    /**
     * Create a virtual display that mirrors the specified display.
     *
     * @param name Display name
     * @param width Width in pixels
     * @param height Height in pixels
     * @param displayIdToMirror The display ID to mirror
     * @param surface Surface to render to
     * @return VirtualDisplay instance
     */
    fun createVirtualDisplay(
        name: String,
        width: Int,
        height: Int,
        displayIdToMirror: Int,
        surface: Surface
    ): VirtualDisplay {
        val flags = VIRTUAL_DISPLAY_FLAG_PUBLIC or
                VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY or
                VIRTUAL_DISPLAY_FLAG_DESTROY_CONTENT_ON_REMOVAL

        return try {
            if (createVirtualDisplayMethod == null) {
                createVirtualDisplayMethod = findCreateVirtualDisplayMethod()
            }

            val callback = createVirtualDisplayCallback()
            val result = createVirtualDisplayMethod!!.invoke(
                manager,
                callback,  // IVirtualDisplayCallback
                null,      // IMediaProjection
                "com.androidremote.screenserver", // Package name
                name,
                width,
                height,
                72,        // DPI
                surface,
                flags,
                null       // uniqueId
            )

            result as? VirtualDisplay
                ?: throw RuntimeException("createVirtualDisplay returned null")
        } catch (e: Exception) {
            throw RuntimeException("Failed to create virtual display", e)
        }
    }

    private fun findCreateVirtualDisplayMethod(): Method {
        val iDisplayManager = Class.forName("android.hardware.display.IDisplayManager")

        // Try different method signatures for different Android versions
        val signatures = listOf(
            // Android 14+
            arrayOf(
                Class.forName("android.hardware.display.IVirtualDisplayCallback"),
                Class.forName("android.media.projection.IMediaProjection"),
                String::class.java,  // packageName
                String::class.java,  // name
                Int::class.javaPrimitiveType,  // width
                Int::class.javaPrimitiveType,  // height
                Int::class.javaPrimitiveType,  // densityDpi
                Surface::class.java,
                Int::class.javaPrimitiveType,  // flags
                String::class.java   // uniqueId
            )
        )

        for (sig in signatures) {
            try {
                return iDisplayManager.getMethod("createVirtualDisplay", *sig)
            } catch (e: NoSuchMethodException) {
                continue
            }
        }

        throw RuntimeException("Could not find createVirtualDisplay method")
    }

    private fun createVirtualDisplayCallback(): Any {
        // Create a proxy for IVirtualDisplayCallback
        val callbackClass = Class.forName("android.hardware.display.IVirtualDisplayCallback")
        val stubClass = Class.forName("android.hardware.display.IVirtualDisplayCallback\$Stub")

        return java.lang.reflect.Proxy.newProxyInstance(
            stubClass.classLoader,
            arrayOf(callbackClass)
        ) { _, method, _ ->
            // Return null or default values for all callback methods
            when (method.returnType) {
                Void.TYPE -> null
                Boolean::class.javaPrimitiveType -> false
                Int::class.javaPrimitiveType -> 0
                else -> null
            }
        }
    }
}
