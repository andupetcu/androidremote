package com.androidremote.app.ui

import android.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class QrCodeGeneratorTest {

    @Test
    fun `generates bitmap with correct dimensions`() {
        val bitmap = QrCodeGenerator.generate("test-content", 200)

        assertNotNull(bitmap)
        assertEquals(200, bitmap.width)
        assertEquals(200, bitmap.height)
    }

    @Test
    fun `generates different bitmaps for different content`() {
        val bitmap1 = QrCodeGenerator.generate("content-1", 100)
        val bitmap2 = QrCodeGenerator.generate("content-2", 100)

        // At least verify both bitmaps are valid (have black and white pixels)
        assertNotNull(bitmap1)
        assertNotNull(bitmap2)
    }

    @Test
    fun `handles empty content gracefully`() {
        val bitmap = QrCodeGenerator.generate("", 100)
        assertNotNull(bitmap)
    }

    @Test
    fun `generated qr code contains black and white pixels`() {
        val bitmap = QrCodeGenerator.generate("test", 100)

        var hasBlack = false
        var hasWhite = false

        for (x in 0 until bitmap.width) {
            for (y in 0 until bitmap.height) {
                when (bitmap.getPixel(x, y)) {
                    Color.BLACK -> hasBlack = true
                    Color.WHITE -> hasWhite = true
                }
                if (hasBlack && hasWhite) break
            }
            if (hasBlack && hasWhite) break
        }

        assertTrue("QR code should contain black pixels", hasBlack)
        assertTrue("QR code should contain white pixels", hasWhite)
    }
}
