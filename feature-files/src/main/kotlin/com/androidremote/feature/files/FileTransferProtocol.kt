package com.androidremote.feature.files

import java.util.zip.CRC32

/**
 * A chunk of file data for transfer.
 *
 * @property data The actual bytes in this chunk
 * @property sequenceNumber Zero-based index of this chunk
 * @property totalChunks Total number of chunks in the transfer
 * @property checksum CRC32 checksum for integrity verification
 */
data class FileChunk(
    val data: ByteArray,
    val sequenceNumber: Int,
    val totalChunks: Int,
    val checksum: Long
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (javaClass != other?.javaClass) return false
        other as FileChunk
        return sequenceNumber == other.sequenceNumber &&
                totalChunks == other.totalChunks &&
                checksum == other.checksum &&
                data.contentEquals(other.data)
    }

    override fun hashCode(): Int {
        var result = data.contentHashCode()
        result = 31 * result + sequenceNumber
        result = 31 * result + totalChunks
        result = 31 * result + checksum.hashCode()
        return result
    }
}

/**
 * Metadata about a file being transferred.
 *
 * @property name File name
 * @property mimeType MIME type of the file
 * @property size File size in bytes
 */
data class FileMetadata(
    val name: String,
    val mimeType: String,
    val size: Long
)

/**
 * A complete file transfer with metadata and chunks.
 *
 * @property metadata Information about the file
 * @property chunks All chunks that make up the file
 */
data class FileTransfer(
    val metadata: FileMetadata,
    val chunks: List<FileChunk>
) {
    /**
     * Calculate transfer progress based on chunks received.
     *
     * @param chunksReceived Number of chunks received so far
     * @return Progress as a float from 0.0 to 1.0
     */
    fun getProgress(chunksReceived: Int): Float {
        if (chunks.isEmpty()) return 1.0f
        return chunksReceived.toFloat() / chunks.size
    }
}

/**
 * Result of attempting to reassemble chunks.
 *
 * @property isComplete Whether all chunks are present
 * @property missingChunks List of missing chunk sequence numbers
 * @property data Reassembled data if complete, null otherwise
 */
data class ReassemblyResult(
    val isComplete: Boolean,
    val missingChunks: List<Int>,
    val data: ByteArray? = null
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (javaClass != other?.javaClass) return false
        other as ReassemblyResult
        return isComplete == other.isComplete &&
                missingChunks == other.missingChunks &&
                (data?.contentEquals(other.data) ?: (other.data == null))
    }

    override fun hashCode(): Int {
        var result = isComplete.hashCode()
        result = 31 * result + missingChunks.hashCode()
        result = 31 * result + (data?.contentHashCode() ?: 0)
        return result
    }
}

/**
 * Protocol for chunked file transfers with integrity verification.
 *
 * Files are split into chunks for:
 * - Progress tracking during transfer
 * - Handling large files that don't fit in memory at once
 * - Integrity verification per chunk
 *
 * @property chunkSize Maximum size of each chunk in bytes
 */
class FileTransferProtocol(
    private val chunkSize: Int = DEFAULT_CHUNK_SIZE
) {
    companion object {
        /** Default chunk size: 64KB */
        const val DEFAULT_CHUNK_SIZE = 64 * 1024
    }

    /**
     * Split data into chunks for transfer.
     *
     * @param data The data to chunk
     * @return List of chunks with sequence numbers and checksums
     */
    fun chunk(data: ByteArray): List<FileChunk> {
        // Handle empty data as single empty chunk
        if (data.isEmpty()) {
            return listOf(
                FileChunk(
                    data = ByteArray(0),
                    sequenceNumber = 0,
                    totalChunks = 1,
                    checksum = calculateChecksum(ByteArray(0))
                )
            )
        }

        val totalChunks = (data.size + chunkSize - 1) / chunkSize
        val chunks = mutableListOf<FileChunk>()

        for (i in 0 until totalChunks) {
            val start = i * chunkSize
            val end = minOf(start + chunkSize, data.size)
            val chunkData = data.copyOfRange(start, end)

            chunks.add(
                FileChunk(
                    data = chunkData,
                    sequenceNumber = i,
                    totalChunks = totalChunks,
                    checksum = calculateChecksum(chunkData)
                )
            )
        }

        return chunks
    }

    /**
     * Reassemble chunks back into original data.
     *
     * Chunks can be provided in any order; they will be sorted by sequence number.
     *
     * @param chunks The chunks to reassemble
     * @return The reassembled data
     * @throws IllegalArgumentException if chunks are incomplete
     */
    fun reassemble(chunks: List<FileChunk>): ByteArray {
        if (chunks.isEmpty()) {
            throw IllegalArgumentException("No chunks to reassemble")
        }

        val sorted = chunks.sortedBy { it.sequenceNumber }
        val totalSize = sorted.sumOf { it.data.size }
        val result = ByteArray(totalSize)

        var offset = 0
        for (chunk in sorted) {
            chunk.data.copyInto(result, offset)
            offset += chunk.data.size
        }

        return result
    }

    /**
     * Try to reassemble chunks, reporting any missing chunks.
     *
     * @param chunks The chunks to attempt to reassemble
     * @return Result indicating completeness and any missing chunks
     */
    fun tryReassemble(chunks: List<FileChunk>): ReassemblyResult {
        if (chunks.isEmpty()) {
            return ReassemblyResult(
                isComplete = false,
                missingChunks = emptyList()
            )
        }

        val totalChunks = chunks.first().totalChunks
        val presentChunks = chunks.map { it.sequenceNumber }.toSet()
        val missingChunks = (0 until totalChunks).filter { it !in presentChunks }

        return if (missingChunks.isEmpty()) {
            ReassemblyResult(
                isComplete = true,
                missingChunks = emptyList(),
                data = reassemble(chunks)
            )
        } else {
            ReassemblyResult(
                isComplete = false,
                missingChunks = missingChunks
            )
        }
    }

    /**
     * Verify chunk integrity using its checksum.
     *
     * @param chunk The chunk to verify
     * @return true if checksum matches, false if corrupted
     */
    fun verifyChecksum(chunk: FileChunk): Boolean {
        val expectedChecksum = calculateChecksum(chunk.data)
        return chunk.checksum == expectedChecksum
    }

    /**
     * Create a complete file transfer with metadata.
     *
     * @param data The file data
     * @param metadata Information about the file
     * @return FileTransfer ready for transmission
     */
    fun createTransfer(data: ByteArray, metadata: FileMetadata): FileTransfer {
        return FileTransfer(
            metadata = metadata,
            chunks = chunk(data)
        )
    }

    /**
     * Calculate CRC32 checksum for data.
     */
    private fun calculateChecksum(data: ByteArray): Long {
        val crc = CRC32()
        crc.update(data)
        return crc.value
    }
}
