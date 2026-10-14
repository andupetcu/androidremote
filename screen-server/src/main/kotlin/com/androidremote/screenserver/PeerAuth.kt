package com.androidremote.screenserver

/**
 * Peer authentication for the abstract-namespace socket. Abstract sockets have no
 * filesystem permissions, so the server checks the connecting peer's uid instead.
 */
object PeerAuth {

    /** True only when the peer uid is known and equals the configured app uid. Fails closed. */
    fun isAllowed(peerUid: Int?, expectedUid: Int?): Boolean {
        if (expectedUid == null || expectedUid < 0) return false
        if (peerUid == null || peerUid < 0) return false
        return peerUid == expectedUid
    }

    /** Parses `-u <uid>` from the server arguments. Null when absent or invalid. */
    fun parseExpectedUid(args: Array<String>): Int? {
        val i = args.indexOf("-u")
        if (i < 0) return null
        val uid = args.getOrNull(i + 1)?.toIntOrNull() ?: return null
        return uid.takeIf { it >= 0 }
    }
}
