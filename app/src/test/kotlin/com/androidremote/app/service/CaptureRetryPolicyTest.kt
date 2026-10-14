package com.androidremote.app.service

import com.google.common.truth.Truth.assertThat
import org.junit.jupiter.api.Test

class CaptureRetryPolicyTest {
    private val policy = CaptureRetryPolicy(baseDelayMs = 1_000, maxDelayMs = 30_000)

    @Test
    fun `delay doubles per attempt and is capped`() {
        assertThat(policy.delayMs(1)).isEqualTo(1_000)
        assertThat(policy.delayMs(2)).isEqualTo(2_000)
        assertThat(policy.delayMs(3)).isEqualTo(4_000)
        assertThat(policy.delayMs(5)).isEqualTo(16_000)
        assertThat(policy.delayMs(6)).isEqualTo(30_000)
        assertThat(policy.delayMs(100)).isEqualTo(30_000)
    }

    @Test
    fun `attempt below one is treated as the first`() {
        assertThat(policy.delayMs(0)).isEqualTo(1_000)
        assertThat(policy.delayMs(-3)).isEqualTo(1_000)
    }
}
