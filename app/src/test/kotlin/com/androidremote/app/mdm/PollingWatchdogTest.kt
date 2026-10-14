package com.androidremote.app.mdm

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class PollingWatchdogTest {
    @Test
    fun `restarts only when enrolled, valid and the service is dead`() {
        assertTrue(PollingWatchdog.shouldRestart(enrolled = true, enrollmentInvalid = false, serviceRunning = false))
        assertFalse(PollingWatchdog.shouldRestart(enrolled = true, enrollmentInvalid = false, serviceRunning = true))
        assertFalse(PollingWatchdog.shouldRestart(enrolled = false, enrollmentInvalid = false, serviceRunning = false))
        assertFalse(PollingWatchdog.shouldRestart(enrolled = true, enrollmentInvalid = true, serviceRunning = false))
    }

    @Test
    fun `backstop period is 15 minutes`() {
        assertEquals(15L, PollingWatchdog.PERIOD_MINUTES)
    }
}

class BatteryExemptionPlanTest {
    @Test
    fun `only a device owner that is not yet exempt requests the exemption`() {
        assertEquals(BatteryExemption.Plan.REQUEST, BatteryExemption.plan(alreadyExempt = false, isDeviceOwner = true))
        assertEquals(BatteryExemption.Plan.NONE, BatteryExemption.plan(alreadyExempt = true, isDeviceOwner = true))
        assertEquals(BatteryExemption.Plan.NONE, BatteryExemption.plan(alreadyExempt = false, isDeviceOwner = false))
    }
}
