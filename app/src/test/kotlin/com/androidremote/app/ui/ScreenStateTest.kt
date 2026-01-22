package com.androidremote.app.ui

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class ScreenStateTest {

    @Test
    fun `screen states have correct ViewFlipper indices`() {
        assertEquals(0, ScreenState.PERMISSIONS.index)
        assertEquals(1, ScreenState.READY.index)
        assertEquals(2, ScreenState.PAIRING.index)
        assertEquals(3, ScreenState.CONNECTED.index)
        assertEquals(4, ScreenState.ERROR.index)
    }

    @Test
    fun `all screen states have unique indices`() {
        val indices = ScreenState.entries.map { it.index }
        assertEquals(indices.size, indices.toSet().size)
    }
}
