package com.androidremote.app.ui

/**
 * Screen states for MainActivity ViewFlipper.
 * Each state maps to a child view index.
 *
 * Flow:
 * - MDM enrollment: PERMISSIONS → ENROLLMENT → MANAGED (waiting for server commands)
 * - Manual pairing: PERMISSIONS → READY → PAIRING → CONNECTED
 * - Admin triggers START_REMOTE: MANAGED → CONNECTED
 */
enum class ScreenState(val index: Int) {
    PERMISSIONS(0),
    ENROLLMENT(1),
    READY(2),
    PAIRING(3),
    CONNECTED(4),
    MANAGED(5)
}
