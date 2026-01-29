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
    val flags: Int,
    val logicalDensityDpi: Int,
    val physicalWidth: Int,
    val physicalHeight: Int
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

                // Read density info for projection correction
                val logicalDensityDpi = tryGetInt(infoClass, info, "logicalDensityDpi", 0)

                // Read physical (native) display dimensions from DisplayMode
                var physWidth = logicalWidth
                var physHeight = logicalHeight
                try {
                    val mode = infoClass.getField("supportedModes").get(info)
                    if (mode != null && mode is Array<*> && mode.isNotEmpty()) {
                        val displayMode = mode[0]!!
                        val modeClass = displayMode.javaClass
                        physWidth = modeClass.getMethod("getPhysicalWidth").invoke(displayMode) as Int
                        physHeight = modeClass.getMethod("getPhysicalHeight").invoke(displayMode) as Int
                    }
                } catch (e: Exception) {
                    System.err.println("Could not read physical display mode: ${e.message}")
                }

                // Log all display info for diagnostics
                System.err.println("DisplayInfo[$displayId]: logical=${logicalWidth}x${logicalHeight}" +
                        ", physical=${physWidth}x${physHeight}" +
                        ", rotation=$rotation, layerStack=$layerStack" +
                        ", densityDpi=$logicalDensityDpi" +
                        ", flags=$flags")

                // Also dump all available fields for debugging
                try {
                    for (field in infoClass.fields) {
                        try {
                            val value = field.get(info)
                            System.err.println("  DisplayInfo.${field.name} = $value")
                        } catch (_: Exception) {}
                    }
                } catch (_: Exception) {}

                return DisplayInfo(
                    displayId = displayId,
                    width = logicalWidth,
                    height = logicalHeight,
                    rotation = rotation,
                    layerStack = layerStack,
                    flags = flags,
                    logicalDensityDpi = logicalDensityDpi,
                    physicalWidth = physWidth,
                    physicalHeight = physHeight
                )
            } catch (e: Exception) {
                throw RuntimeException("Failed to get display info for display $displayId", e)
            }
        }

        private fun tryGetInt(clazz: Class<*>, obj: Any, fieldName: String, default: Int): Int {
            return try {
                clazz.getField(fieldName).getInt(obj)
            } catch (e: Exception) {
                default
            }
        }
    }
}
