package com.androidremote.app.service

import com.google.common.truth.Truth.assertThat
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.EOFException
import java.io.IOException

class FrameReaderTest {

    private fun packet(flags: Int, payload: ByteArray): ByteArray {
        val bos = ByteArrayOutputStream()
        val out = DataOutputStream(bos)
        out.writeInt(payload.size)
        out.writeByte(flags)
        out.write(payload)
        return bos.toByteArray()
    }

    private fun reader(vararg parts: ByteArray, max: Int = 1024): FrameReader =
        FrameReader(DataInputStream(ByteArrayInputStream(parts.reduce { a, b -> a + b })), max)

    @Test
    fun `reads a normal frame with its flags`() {
        val r = reader(packet(0x01, byteArrayOf(1, 2, 3)))
        val p = r.next() as ScreenPacket.Frame
        assertThat(p.data).isEqualTo(byteArrayOf(1, 2, 3))
        assertThat(p.isKeyFrame).isTrue()
        assertThat(p.isConfig).isFalse()
    }

    @Test
    fun `frame above the old 1 MiB limit is delivered`() {
        val big = ByteArray(2 * 1024 * 1024) { 5 }
        val r = reader(packet(0x01, big), max = 8 * 1024 * 1024)
        val p = r.next() as ScreenPacket.Frame
        assertThat(p.data.size).isEqualTo(big.size)
    }

    @Test
    fun `oversized frame is skipped and the stream keeps going`() {
        val oversized = ByteArray(2000)
        val ok = byteArrayOf(4, 4)
        val r = reader(packet(0x01, oversized), packet(0x00, ok), max = 1024)
        val first = r.next()
        assertThat(first).isInstanceOf(ScreenPacket.Skipped::class.java)
        assertThat((first as ScreenPacket.Skipped).size).isEqualTo(2000)
        assertThat(first.wasKeyFrame).isTrue()
        val second = r.next() as ScreenPacket.Frame
        assertThat(second.data).isEqualTo(ok)
    }

    @Test
    fun `zero or negative size is a protocol violation`() {
        val bos = ByteArrayOutputStream()
        DataOutputStream(bos).apply { writeInt(0); writeByte(0) }
        assertThrows(FrameProtocolException::class.java) { reader(bos.toByteArray()).next() }
        val neg = ByteArrayOutputStream()
        DataOutputStream(neg).apply { writeInt(-5); writeByte(0) }
        assertThrows(FrameProtocolException::class.java) { reader(neg.toByteArray()).next() }
    }

    @Test
    fun `absurd size beyond the hard cap is a protocol violation, not a skip`() {
        val bos = ByteArrayOutputStream()
        DataOutputStream(bos).apply { writeInt(Int.MAX_VALUE); writeByte(0) }
        assertThrows(FrameProtocolException::class.java) { reader(bos.toByteArray()).next() }
    }

    @Test
    fun `truncated payload surfaces as an IOException`() {
        val bos = ByteArrayOutputStream()
        DataOutputStream(bos).apply { writeInt(10); writeByte(0); write(byteArrayOf(1, 2)) }
        assertThrows(IOException::class.java) { reader(bos.toByteArray()).next() }
        assertThrows(EOFException::class.java) { FrameReader(DataInputStream(ByteArrayInputStream(ByteArray(0))), 10).next() }
    }

    @Test
    fun `screen info packet is parsed`() {
        val payload = ByteArrayOutputStream()
        DataOutputStream(payload).apply { writeInt(2400); writeInt(1080); writeInt(90) }
        val r = reader(packet(0x04, payload.toByteArray()))
        val p = r.next() as ScreenPacket.Info
        assertThat(p.width).isEqualTo(2400)
        assertThat(p.height).isEqualTo(1080)
        assertThat(p.rotation).isEqualTo(90)
    }

    @Test
    fun `malformed screen info payload is a protocol violation`() {
        val r = reader(packet(0x04, byteArrayOf(1, 2, 3)))
        assertThrows(FrameProtocolException::class.java) { r.next() }
    }

    @Test
    fun `control message encoding for keyframe request`() {
        assertThat(ScreenControl.requestSyncFrame()).isEqualTo(byteArrayOf(0x01))
    }
}
