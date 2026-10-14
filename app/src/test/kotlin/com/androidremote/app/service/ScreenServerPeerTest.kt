package com.androidremote.app.service

import com.google.common.truth.Truth.assertThat
import org.junit.jupiter.api.Test

class ScreenServerPeerTest {
    @Test
    fun `server must run as shell, root or this app`() {
        assertThat(ScreenServerPeer.isTrustedServerUid(2000, 10100)).isTrue()
        assertThat(ScreenServerPeer.isTrustedServerUid(0, 10100)).isTrue()
        assertThat(ScreenServerPeer.isTrustedServerUid(10100, 10100)).isTrue()
    }

    @Test
    fun `any other app impersonating the server is rejected`() {
        assertThat(ScreenServerPeer.isTrustedServerUid(10999, 10100)).isFalse()
        assertThat(ScreenServerPeer.isTrustedServerUid(null, 10100)).isFalse()
        assertThat(ScreenServerPeer.isTrustedServerUid(-1, 10100)).isFalse()
    }
}
