package com.androidremote.app.ui

import android.graphics.Bitmap
import android.graphics.Color
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter

/**
 * Generates QR code bitmaps from string content using ZXing.
 */
object QrCodeGenerator {

    /**
     * Generate a QR code bitmap.
     *
     * @param content The string to encode
     * @param size The width and height of the resulting bitmap in pixels
     * @return A square bitmap containing the QR code
     */
    fun generate(content: String, size: Int): Bitmap {
        val hints = mapOf(
            EncodeHintType.MARGIN to 1,
            EncodeHintType.CHARACTER_SET to "UTF-8"
        )

        val contentToEncode = content.ifEmpty { " " }
        val bitMatrix = QRCodeWriter().encode(
            contentToEncode,
            BarcodeFormat.QR_CODE,
            size,
            size,
            hints
        )

        val pixels = IntArray(size * size)
        for (y in 0 until size) {
            for (x in 0 until size) {
                pixels[y * size + x] = if (bitMatrix[x, y]) Color.BLACK else Color.WHITE
            }
        }

        return Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888).apply {
            setPixels(pixels, 0, size, 0, 0, size, size)
        }
    }
}
