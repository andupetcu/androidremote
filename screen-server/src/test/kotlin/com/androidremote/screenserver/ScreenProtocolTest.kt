package com.androidremote.screenserver

import com.androidremote.screenserver.protocol.DisplayChangeDetector
import com.androidremote.screenserver.protocol.DisplayState
import com.androidremote.screenserver.protocol.ScreenProtocol
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.ByteArrayInputStream
import java.io.DataInputStream

class ScreenProtocolTest {

    @Test
    fun `packet is size, flags, data`() {
        val bytes = ScreenProtocol.encodePacket(ScreenProtocol.FLAG_KEY_FRAME, byteArrayOf(9, 8, 7))
        val din = DataInputStream(ByteArrayInputStream(bytes))
        assertEquals(3, din.readInt())
        assertEquals(1, din.readByte().toInt())
        assertEquals(9, din.readByte().toInt())
        assertEquals(8, bytes.size)
    }

    @Test
    fun `screen info packet carries width height rotation under its own flag`() {
        val bytes = ScreenProtocol.encodeScreenInfo(1080, 2400, 90)
        val din = DataInputStream(ByteArrayInputStream(bytes))
        assertEquals(12, din.readInt())
        assertEquals(ScreenProtocol.FLAG_SCREEN_INFO, din.readByte().toInt() and 0xFF)
        assertEquals(1080, din.readInt())
        assertEquals(2400, din.readInt())
        assertEquals(90, din.readInt())
    }

    @Test
    fun `request sync frame control byte is recognised and others are not`() {
        assertEquals(0x01, ScreenProtocol.CONTROL_REQUEST_SYNC_FRAME)
        assertTrue(ScreenProtocol.isRequestSyncFrame(0x01))
        assertFalse(ScreenProtocol.isRequestSyncFrame(0x02))
        assertFalse(ScreenProtocol.isRequestSyncFrame(-1))
    }

    @Test
    fun `rotation maps surface constants to degrees`() {
        assertEquals(0, ScreenProtocol.rotationDegrees(0))
        assertEquals(90, ScreenProtocol.rotationDegrees(1))
        assertEquals(180, ScreenProtocol.rotationDegrees(2))
        assertEquals(270, ScreenProtocol.rotationDegrees(3))
        assertEquals(0, ScreenProtocol.rotationDegrees(7))
    }

    @Test
    fun `change detector fires on rotation or size change only`() {
        val a = DisplayState(1080, 2400, 0)
        assertFalse(DisplayChangeDetector.hasChanged(a, DisplayState(1080, 2400, 0)))
        assertTrue(DisplayChangeDetector.hasChanged(a, DisplayState(2400, 1080, 1)))
        assertTrue(DisplayChangeDetector.hasChanged(a, DisplayState(1080, 2400, 2)))
        assertTrue(DisplayChangeDetector.hasChanged(a, DisplayState(720, 1600, 0)))
    }

    @Test
    fun `shutdown hook is registered once and stops only the current encoder`() {
        var installs = 0
        var hook: Runnable? = null
        val registry = com.androidremote.screenserver.protocol.StopHook { r -> installs++; hook = r }
        var stopped1 = 0
        var stopped2 = 0
        registry.track { stopped1++ }
        registry.track { stopped2++ }
        registry.track { }
        assertEquals(1, installs)
        registry.track { stopped2++ }
        hook!!.run()
        assertEquals(0, stopped1)
        assertEquals(1, stopped2)
    }
}
