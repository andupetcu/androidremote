package com.androidremote.app.mdm

/** Remote desktop is supported on rooted devices only; START_REMOTE fails up front otherwise. */
object RemoteDesktopGate {
    const val ROOT_REQUIRED_MESSAGE = "Remote desktop requires a rooted device"

    fun failureMessage(rooted: Boolean): String? = if (rooted) null else ROOT_REQUIRED_MESSAGE
}
