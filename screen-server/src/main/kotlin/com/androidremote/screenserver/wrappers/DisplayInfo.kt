package com.androidremote.screenserver.wrappers

import android.annotation.SuppressLint

/**
 * Display information obtained via reflection from DisplayManager.
 */
data class DisplayInfo(
    val displayId: Int,
    val width: Int,
    val height: Int,
    val rotation: Int,
    val layerStack: Int,
    val flags: Int
) {
    companion object {
        const val FLAG_SUPPORTS_PROTECTED_BUFFERS = 1 shl 0

        @SuppressLint("PrivateApi", "DiscouragedPrivateApi")
        fun getDisplayInfo(displayId: Int): DisplayInfo {
            try {
                // Get DisplayManagerGlobal instance
                val dmgClass = Class.forName("android.hardware.display.DisplayManagerGlobal")
                val getInstance = dmgClass.getMethod("getInstance")
                val dmg = getInstance.invoke(null)

                // Get DisplayInfo
                val getDisplayInfo = dmgClass.getMethod("getDisplayInfo", Int::class.javaPrimitiveType)
                val info = getDisplayInfo.invoke(dmg, displayId)
                    ?: throw RuntimeException("Display $displayId not found")

                // Extract fields from android.view.DisplayInfo
                val infoClass = info.javaClass

                val logicalWidth = infoClass.getField("logicalWidth").getInt(info)
                val logicalHeight = infoClass.getField("logicalHeight").getInt(info)
                val rotation = infoClass.getField("rotation").getInt(info)
                val layerStack = infoClass.getField("layerStack").getInt(info)
                val flags = infoClass.getField("flags").getInt(info)

                return DisplayInfo(
                    displayId = displayId,
                    width = logicalWidth,
                    height = logicalHeight,
                    rotation = rotation,
                    layerStack = layerStack,
                    flags = flags
                )
            } catch (e: Exception) {
                throw RuntimeException("Failed to get display info for display $displayId", e)
            }
        }
    }
}
