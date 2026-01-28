package com.androidremote.feature.files

import com.google.common.truth.Truth.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource

/**
 * Tests for file transfer protocol.
 *
 * Files are transferred in chunks to handle large files and allow
 * progress tracking. Each chunk includes a checksum for integrity verification.
 *
 * These tests are written FIRST (TDD) - implementation follows.
 */
class FileTransferProtocolTest {

    private lateinit var protocol: FileTransferProtocol

    @BeforeEach
    fun setUp() {
        protocol = FileTransferProtocol(chunkSize = 1024) // 1KB chunks for testing
    }

    @Test
    fun `chunks small file into single chunk`() {
        val data = ByteArray(500) { it.toByte() }

        val chunks = protocol.chunk(data)

        assertThat(chunks).hasSize(1)
        assertThat(chunks[0].data).isEqualTo(data)
        assertThat(chunks[0].sequenceNumber).isEqualTo(0)
        assertThat(chunks[0].totalChunks).isEqualTo(1)
    }

    @Test
    fun `chunks large file into multiple chunks`() {
        val largeFile = ByteArray(10 * 1024) { it.toByte() } // 10 KB

        val chunks = protocol.chunk(largeFile)

        assertThat(chunks).hasSize(10)
        assertThat(chunks.sumOf { it.data.size }).isEqualTo(largeFile.size)
    }

    @Test
    fun `chunks have sequential sequence numbers`() {
        val data = ByteArray(5 * 1024) { it.toByte() } // 5 KB

        val chunks = protocol.chunk(data)

        chunks.forEachIndexed { index, chunk ->
            assertThat(chunk.sequenceNumber).isEqualTo(index)
        }
    }

    @Test
    fun `all chunks know total chunk count`() {
        val data = ByteArray(5 * 1024) { it.toByte() }

        val chunks = protocol.chunk(data)

        chunks.forEach { chunk ->
            assertThat(chunk.totalChunks).isEqualTo(5)
        }
    }

    @Test
    fun `reassembles chunks correctly`() {
        val original = "Hello, World!".repeat(1000).toByteArray()

        val chunks = protocol.chunk(original)
        val reassembled = protocol.reassemble(chunks)

        assertThat(reassembled).isEqualTo(original)
    }

    @Test
    fun `reassembles out-of-order chunks`() {
        val original = ByteArray(5 * 1024) { it.toByte() }

        val chunks = protocol.chunk(original)
        val shuffled = chunks.shuffled()
        val reassembled = protocol.reassemble(shuffled)

        assertThat(reassembled).isEqualTo(original)
    }

    @Test
    fun `includes checksum for integrity`() {
        val data = "Test data".toByteArray()

        val chunks = protocol.chunk(data)

        assertThat(chunks[0].checksum).isNotEqualTo(0L)
    }

    @Test
    fun `verifies chunk integrity with checksum`() {
        val data = "Test data".toByteArray()

        val chunks = protocol.chunk(data)
        val isValid = protocol.verifyChecksum(chunks[0])

        assertThat(isValid).isTrue()
    }

    @Test
    fun `detects corrupted chunk`() {
        val data = "Test data".toByteArray()

        val chunks = protocol.chunk(data)
        // Corrupt the data
        val corruptedChunk = chunks[0].copy(
            data = chunks[0].data.copyOf().also { it[0] = (it[0].toInt() xor 0xFF).toByte() }
        )
        val isValid = protocol.verifyChecksum(corruptedChunk)

        assertThat(isValid).isFalse()
    }

    @Test
    fun `handles empty file`() {
        val emptyData = ByteArray(0)

        val chunks = protocol.chunk(emptyData)

        assertThat(chunks).hasSize(1)
        assertThat(chunks[0].data).isEmpty()
    }

    @Test
    fun `handles file size exactly matching chunk size`() {
        val data = ByteArray(1024) { it.toByte() } // Exactly 1 chunk

        val chunks = protocol.chunk(data)

        assertThat(chunks).hasSize(1)
        assertThat(chunks[0].data.size).isEqualTo(1024)
    }

    @Test
    fun `handles file size one byte over chunk size`() {
        val data = ByteArray(1025) { it.toByte() } // 1 chunk + 1 byte

        val chunks = protocol.chunk(data)

        assertThat(chunks).hasSize(2)
        assertThat(chunks[0].data.size).isEqualTo(1024)
        assertThat(chunks[1].data.size).isEqualTo(1)
    }

    @ParameterizedTest
    @ValueSource(ints = [1, 100, 1023, 1024, 1025, 10000, 100000])
    fun `roundtrip preserves data for various sizes`(size: Int) {
        val original = ByteArray(size) { (it % 256).toByte() }

        val chunks = protocol.chunk(original)
        val reassembled = protocol.reassemble(chunks)

        assertThat(reassembled).isEqualTo(original)
    }

    @Test
    fun `creates transfer with file metadata`() {
        val data = ByteArray(5000) { it.toByte() }
        val metadata = FileMetadata(
            name = "test.txt",
            mimeType = "text/plain",
            size = data.size.toLong()
        )

        val transfer = protocol.createTransfer(data, metadata)

        assertThat(transfer.metadata).isEqualTo(metadata)
        assertThat(transfer.chunks).hasSize(5)
    }

    @Test
    fun `calculates transfer progress`() {
        val data = ByteArray(10 * 1024) { it.toByte() }
        val metadata = FileMetadata("test.bin", "application/octet-stream", data.size.toLong())

        val transfer = protocol.createTransfer(data, metadata)

        assertThat(transfer.getProgress(0)).isEqualTo(0.0f)
        assertThat(transfer.getProgress(5)).isEqualTo(0.5f)
        assertThat(transfer.getProgress(10)).isEqualTo(1.0f)
    }

    @Test
    fun `detects missing chunks during reassembly`() {
        val data = ByteArray(5 * 1024) { it.toByte() }

        val chunks = protocol.chunk(data)
        val incompleteChunks = chunks.filter { it.sequenceNumber != 2 } // Remove chunk 2

        val result = protocol.tryReassemble(incompleteChunks)

        assertThat(result.isComplete).isFalse()
        assertThat(result.missingChunks).contains(2)
    }

    @Test
    fun `custom chunk size is respected`() {
        val customProtocol = FileTransferProtocol(chunkSize = 512)
        val data = ByteArray(2048) { it.toByte() }

        val chunks = customProtocol.chunk(data)

        assertThat(chunks).hasSize(4)
        chunks.dropLast(1).forEach { chunk ->
            assertThat(chunk.data.size).isEqualTo(512)
        }
    }
}
