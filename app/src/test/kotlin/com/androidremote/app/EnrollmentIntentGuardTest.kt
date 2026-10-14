package com.androidremote.app

import com.google.common.truth.Truth.assertThat
import org.junit.jupiter.api.Test

class EnrollmentIntentGuardTest {

    private val own = 10100

    private fun decide(
        enrolled: Boolean = false,
        caller: Int? = 2000,
        token: String? = "ABC23XYZ",
        url: String? = "http://192.168.1.10:7899"
    ) = EnrollmentIntentGuard.decide(enrolled, caller, own, token, url)

    @Test
    fun `ignored once enrolled, whoever the caller is`() {
        assertThat(decide(enrolled = true, caller = 2000)).isEqualTo(EnrollmentIntentGuard.Decision.IgnoreEnrolled)
        assertThat(decide(enrolled = true, caller = own)).isEqualTo(EnrollmentIntentGuard.Decision.IgnoreEnrolled)
    }

    @Test
    fun `adb shell and root callers are honoured`() {
        assertThat(decide(caller = 2000)).isEqualTo(EnrollmentIntentGuard.Decision.Accept)
        assertThat(decide(caller = 0)).isEqualTo(EnrollmentIntentGuard.Decision.Accept)
    }

    @Test
    fun `the app itself is honoured`() {
        assertThat(decide(caller = own)).isEqualTo(EnrollmentIntentGuard.Decision.Accept)
    }

    @Test
    fun `another app needs explicit user confirmation`() {
        assertThat(decide(caller = 10999)).isEqualTo(EnrollmentIntentGuard.Decision.RequireConfirmation)
    }

    @Test
    fun `unknown caller needs explicit user confirmation`() {
        assertThat(decide(caller = null)).isEqualTo(EnrollmentIntentGuard.Decision.RequireConfirmation)
        assertThat(decide(caller = -1)).isEqualTo(EnrollmentIntentGuard.Decision.RequireConfirmation)
    }

    @Test
    fun `missing token is ignored`() {
        assertThat(decide(token = null)).isEqualTo(EnrollmentIntentGuard.Decision.IgnoreInvalid)
        assertThat(decide(token = "  ")).isEqualTo(EnrollmentIntentGuard.Decision.IgnoreInvalid)
    }

    @Test
    fun `server url must be http or https with a host`() {
        assertThat(decide(url = "javascript:alert(1)")).isEqualTo(EnrollmentIntentGuard.Decision.IgnoreInvalid)
        assertThat(decide(url = "file:///etc/passwd")).isEqualTo(EnrollmentIntentGuard.Decision.IgnoreInvalid)
        assertThat(decide(url = "http://")).isEqualTo(EnrollmentIntentGuard.Decision.IgnoreInvalid)
        assertThat(decide(url = null)).isEqualTo(EnrollmentIntentGuard.Decision.Accept)
        assertThat(decide(url = "https://mdm.example.com")).isEqualTo(EnrollmentIntentGuard.Decision.Accept)
    }
}
