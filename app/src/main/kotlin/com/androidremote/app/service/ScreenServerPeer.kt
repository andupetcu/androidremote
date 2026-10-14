package com.androidremote.app.service

/** Client-side check that whoever answers on the abstract socket is really our screen-server. */
object ScreenServerPeer {
    private const val UID_ROOT = 0
    private const val UID_SHELL = 2000

    /** The server is launched via `su 2000` / `su 0` (or by this app). Anything else is an impostor. */
    fun isTrustedServerUid(peerUid: Int?, ownUid: Int): Boolean {
        if (peerUid == null || peerUid < 0) return false
        return peerUid == UID_ROOT || peerUid == UID_SHELL || peerUid == ownUid
    }
}
