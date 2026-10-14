package com.androidremote.app.service

import com.google.common.truth.Truth.assertThat
import org.junit.jupiter.api.Test

class ScreenServerCommandTest {
    @Test
    fun `command passes the app uid via -u`() {
        val cmd = ScreenServerCommand.build(
            apkPath = "/data/local/tmp/screen-server.apk",
            serverClass = "com.androidremote.screenserver.Server",
            appUid = 10234,
            logFile = "/data/local/tmp/screen-server.log",
        )
        assertThat(cmd).contains("app_process / com.androidremote.screenserver.Server")
        assertThat(cmd).contains("-u 10234")
        assertThat(cmd).startsWith("CLASSPATH=/data/local/tmp/screen-server.apk ")
        assertThat(cmd).endsWith("2>/data/local/tmp/screen-server.log &")
    }

    @Test
    fun `log redirect is optional`() {
        val cmd = ScreenServerCommand.build("/a.apk", "X", 1000, logFile = null)
        assertThat(cmd).isEqualTo("CLASSPATH=/a.apk app_process / X -u 1000 &")
    }

    @Test
    fun `manual hint also carries -u`() {
        val hint = ScreenServerCommand.adbHint("/a.apk", "X", 10234)
        assertThat(hint).contains("-u 10234")
    }
}
