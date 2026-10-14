package com.androidremote.app

import com.google.common.truth.Truth.assertThat
import org.junit.jupiter.api.Test

class LogRedactorTest {

    @Test
    fun `secret shows only its length`() {
        val out = LogRedactor.secret("ABC23XYZ")
        assertThat(out).doesNotContain("ABC23XYZ")
        assertThat(out).contains("8")
        assertThat(LogRedactor.secret(null)).isEqualTo("<none>")
    }

    @Test
    fun `typed text shows only its length`() {
        val out = LogRedactor.typedText("hunter2 password")
        assertThat(out).doesNotContain("hunter2")
        assertThat(out).contains("16")
    }

    @Test
    fun `url keeps scheme host and port, drops query userinfo and path`() {
        assertThat(LogRedactor.url("https://user:pw@mdm.example.com:7899/api/x?token=SECRET#frag"))
            .isEqualTo("https://mdm.example.com:7899")
        assertThat(LogRedactor.url("http://192.168.1.10/enroll?t=abc")).isEqualTo("http://192.168.1.10")
    }

    @Test
    fun `unparseable url is not echoed`() {
        assertThat(LogRedactor.url("not a url token=SECRET")).doesNotContain("SECRET")
        assertThat(LogRedactor.url(null)).isEqualTo("<none>")
    }

    @Test
    fun `free text with token query parameters is scrubbed`() {
        val out = LogRedactor.scrub("GET /x?token=SECRET&a=1 Authorization: Bearer SECRET2 session_token=SECRET3")
        assertThat(out).doesNotContain("SECRET")
        assertThat(out).contains("a=1")
    }
}
