package com.androidremote.app.mdm.telemetry

import com.androidremote.app.kiosk.KioskConfig

/** Kiosk and app-management state sent with every telemetry sample. */
data class KioskReport(
    val kioskActive: Boolean,
    val kioskPackage: String?,
    val lockTask: Boolean,
    val protectedPackages: List<String>
) {
    companion object {
        /**
         * Active means configured and, when the foreground app is known, the target is in front.
         * An unknown foreground (null) falls back to "configured".
         */
        fun build(config: KioskConfig?, foreground: String?, protectedPackages: Set<String>) = KioskReport(
            kioskActive = config != null && (foreground == null || foreground == config.packageName),
            kioskPackage = config?.packageName,
            lockTask = config?.lockTask ?: false,
            protectedPackages = protectedPackages.sorted()
        )
    }
}
