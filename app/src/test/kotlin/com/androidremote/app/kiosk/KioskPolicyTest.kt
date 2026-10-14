package com.androidremote.app.kiosk

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

private fun obj(s: String): JsonObject = Json.parseToJsonElement(s).jsonObject

class KioskPolicyTest {
    private val own = "com.androidremote.app"

    @Test
    fun `lock task kiosk whitelists target and self, disables keyguard and status bar, no home replacement`() {
        val plan = KioskPolicy.plan(KioskConfig("com.footprints.player", enabled = true, lockTask = true), own)
        assertEquals(listOf("com.footprints.player", own), plan.lockTaskPackages)
        assertTrue(plan.launchInLockTask)
        assertNull(plan.homeReplacementPackage)
        assertTrue(plan.keyguardDisabled)
        assertTrue(plan.statusBarDisabled)
        assertEquals("com.footprints.player", plan.bootForeground)
    }

    @Test
    fun `non lock task kiosk makes the target the HOME launcher`() {
        val plan = KioskPolicy.plan(KioskConfig("com.footprints.player", enabled = true, lockTask = false), own)
        assertFalse(plan.launchInLockTask)
        assertEquals("com.footprints.player", plan.homeReplacementPackage)
        assertEquals(listOf(own), plan.lockTaskPackages)
        assertTrue(plan.keyguardDisabled)
        assertTrue(plan.statusBarDisabled)
    }

    @Test
    fun `disabling kiosk undoes everything and clears the boot preference`() {
        val plan = KioskPolicy.plan(KioskConfig("com.footprints.player", enabled = false, lockTask = true), own)
        assertEquals(listOf(own), plan.lockTaskPackages)
        assertFalse(plan.launchInLockTask)
        assertNull(plan.homeReplacementPackage)
        assertFalse(plan.keyguardDisabled)
        assertFalse(plan.statusBarDisabled)
        assertNull(plan.bootForeground)
        assertEquals("com.footprints.player", plan.clearBootPackage)
    }

    @Test
    fun `kiosk on the agent itself is not listed twice`() {
        val plan = KioskPolicy.plan(KioskConfig(own, enabled = true, lockTask = true), own)
        assertEquals(listOf(own), plan.lockTaskPackages)
    }

    @Test
    fun `parse reads the C10 payload`() {
        val r = KioskPolicy.parse(obj("""{"packageName":"com.a.b","enabled":true,"lockTask":true}"""))
        assertEquals(KioskParse.Ok(KioskConfig("com.a.b", true, true)), r)
    }

    @Test
    fun `parse accepts string booleans and defaults lockTask to false`() {
        val r = KioskPolicy.parse(obj("""{"packageName":"com.a.b","enabled":"true"}"""))
        assertEquals(KioskParse.Ok(KioskConfig("com.a.b", true, false)), r)
    }

    @Test
    fun `parse rejects missing, malformed or injected package names and missing enabled`() {
        assertTrue(KioskPolicy.parse(obj("""{"enabled":true}""")) is KioskParse.Invalid)
        assertTrue(KioskPolicy.parse(obj("""{"packageName":"nodots","enabled":true}""")) is KioskParse.Invalid)
        assertTrue(KioskPolicy.parse(obj("""{"packageName":"a.b; rm -rf","enabled":true}""")) is KioskParse.Invalid)
        assertTrue(KioskPolicy.parse(obj("""{"packageName":"com.a.b"}""")) is KioskParse.Invalid)
    }
}

class KioskWatchdogTest {
    private val cd = 30_000L

    @Test
    fun `relaunches when the target is not in the foreground and not recently relaunched`() {
        assertTrue(KioskWatchdog.shouldRelaunch("com.p", true, "com.launcher", 100_000, null, cd))
        assertTrue(KioskWatchdog.shouldRelaunch("com.p", true, null, 100_000, 10_000, cd))
    }

    @Test
    fun `does nothing when target is foreground, absent, or not configured`() {
        assertFalse(KioskWatchdog.shouldRelaunch("com.p", true, "com.p", 100_000, null, cd))
        assertFalse(KioskWatchdog.shouldRelaunch(null, true, "x", 100_000, null, cd))
        assertFalse(KioskWatchdog.shouldRelaunch("com.p", false, "x", 100_000, null, cd))
    }

    @Test
    fun `cooldown suppresses repeated relaunches then expires`() {
        assertFalse(KioskWatchdog.shouldRelaunch("com.p", true, "x", 100_000, 80_000, cd))
        assertFalse(KioskWatchdog.shouldRelaunch("com.p", true, "x", 109_999, 80_000, cd))
        assertTrue(KioskWatchdog.shouldRelaunch("com.p", true, "x", 110_000, 80_000, cd))
    }

    @Test
    fun `kiosk target wins over the boot foreground app`() {
        assertEquals("com.k", KioskWatchdog.targetOf("com.k", "com.f"))
        assertEquals("com.f", KioskWatchdog.targetOf(null, "com.f"))
        assertNull(KioskWatchdog.targetOf(null, null))
    }

    @Test
    fun `package events relaunch only for the target`() {
        assertTrue(KioskWatchdog.shouldRelaunchOnPackageEvent("com.p", "com.p"))
        assertFalse(KioskWatchdog.shouldRelaunchOnPackageEvent("com.p", "com.other"))
        assertFalse(KioskWatchdog.shouldRelaunchOnPackageEvent(null, "com.p"))
        assertFalse(KioskWatchdog.shouldRelaunchOnPackageEvent("com.p", null))
    }
}

class MaintenanceWindowTest {
    @Test
    fun `no window means updates may install at any time`() {
        assertTrue(UpdatePolicy.mayInstallNow(null, 12 * 60))
    }

    @Test
    fun `plain and overnight windows`() {
        val day = MaintenanceWindow.parse("02:00", "05:00")!!
        assertTrue(UpdatePolicy.mayInstallNow(day, 2 * 60))
        assertTrue(UpdatePolicy.mayInstallNow(day, 4 * 60 + 59))
        assertFalse(UpdatePolicy.mayInstallNow(day, 5 * 60))
        assertFalse(UpdatePolicy.mayInstallNow(day, 12 * 60))
        val night = MaintenanceWindow.parse("22:00", "04:00")!!
        assertTrue(UpdatePolicy.mayInstallNow(night, 23 * 60))
        assertTrue(UpdatePolicy.mayInstallNow(night, 3 * 60))
        assertFalse(UpdatePolicy.mayInstallNow(night, 12 * 60))
    }

    @Test
    fun `bad times parse to null`() {
        assertNull(MaintenanceWindow.parse("25:00", "05:00"))
        assertNull(MaintenanceWindow.parse("abc", "05:00"))
        assertNull(MaintenanceWindow.parse("02:00", "02:00"))
    }
}

class BootPlanTest {
    @Test
    fun `boot completed order is polling, silent, boot apps, kiosk or foreground last`() {
        val steps = BootPlan.stepsFor(
            "android.intent.action.BOOT_COMPLETED",
            enrolled = true, silentMode = true, kioskConfigured = true, hasBootApps = true, hasForeground = true
        )
        assertEquals(
            listOf(BootStep.START_POLLING, BootStep.APPLY_SILENT_MODE, BootStep.LAUNCH_BOOT_APPS, BootStep.LAUNCH_FOREGROUND),
            steps
        )
    }

    @Test
    fun `not enrolled skips polling, nothing configured gives nothing to launch`() {
        val steps = BootPlan.stepsFor(
            "android.intent.action.BOOT_COMPLETED",
            enrolled = false, silentMode = false, kioskConfigured = false, hasBootApps = false, hasForeground = false
        )
        assertTrue(steps.isEmpty())
    }

    @Test
    fun `locked boot only brings the kiosk up (credential storage is not readable yet)`() {
        val steps = BootPlan.stepsFor(
            "android.intent.action.LOCKED_BOOT_COMPLETED",
            enrolled = true, silentMode = true, kioskConfigured = true, hasBootApps = true, hasForeground = true
        )
        assertEquals(listOf(BootStep.LAUNCH_FOREGROUND), steps)
        assertTrue(
            BootPlan.stepsFor(
                "android.intent.action.LOCKED_BOOT_COMPLETED",
                enrolled = true, silentMode = false, kioskConfigured = false, hasBootApps = true, hasForeground = true
            ).isEmpty()
        )
    }

    @Test
    fun `unknown actions do nothing`() {
        assertTrue(BootPlan.stepsFor("android.intent.action.USER_PRESENT", true, true, true, true, true).isEmpty())
    }
}
