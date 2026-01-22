package com.androidremote.app.ui

/**
 * Screen states for MainActivity ViewFlipper.
 * Each state maps to a child view index.
 */
enum class ScreenState(val index: Int) {
    PERMISSIONS(0),
    READY(1),
    PAIRING(2),
    CONNECTED(3),
    ERROR(4)
}
