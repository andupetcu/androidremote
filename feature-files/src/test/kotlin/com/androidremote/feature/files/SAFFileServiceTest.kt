package com.androidremote.feature.files

import com.google.common.truth.Truth.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.assertThrows

/**
 * Tests for SAF (Storage Access Framework) file operations.
 *
 * The SAFFileService provides file system access through Android's
 * scoped storage mechanism. Users grant access to specific directories,
 * and the service operates within those boundaries.
 *
 * These tests use a mock document tree to avoid Android framework dependencies.
 * Tests are written FIRST (TDD) - implementation follows.
 */
class SAFFileServiceTest {

    private lateinit var documentTree: MockDocumentTree
    private lateinit var fileService: SAFFileService

    @BeforeEach
    fun setUp() {
        documentTree = MockDocumentTree()
        fileService = SAFFileService(documentTree)
    }

    // ==================== List Files ====================

    @Test
    fun `lists files in granted directory`() {
        documentTree.addFile("photo.jpg", byteArrayOf(1, 2, 3), "image/jpeg")
        documentTree.addFile("document.pdf", byteArrayOf(4, 5, 6), "application/pdf")
        documentTree.addFile("video.mp4", byteArrayOf(7, 8, 9), "video/mp4")

        val files = fileService.listFiles()

        assertThat(files).hasSize(3)
        assertThat(files.map { it.name }).containsExactly("photo.jpg", "document.pdf", "video.mp4")
    }

    @Test
    fun `lists empty directory`() {
        val files = fileService.listFiles()

        assertThat(files).isEmpty()
    }

    @Test
    fun `lists subdirectories`() {
        documentTree.addDirectory("Documents")
        documentTree.addDirectory("Pictures")
        documentTree.addFile("readme.txt", "Hello".toByteArray(), "text/plain")

        val files = fileService.listFiles()

        val directories = files.filter { it.isDirectory }
        val regularFiles = files.filter { !it.isDirectory }

        assertThat(directories).hasSize(2)
        assertThat(regularFiles).hasSize(1)
    }

    @Test
    fun `includes file metadata in listing`() {
        val content = "Hello, World!".toByteArray()
        documentTree.addFile("test.txt", content, "text/plain", lastModified = 1700000000000L)

        val files = fileService.listFiles()

        assertThat(files).hasSize(1)
        val file = files[0]
        assertThat(file.name).isEqualTo("test.txt")
        assertThat(file.size).isEqualTo(content.size.toLong())
        assertThat(file.mimeType).isEqualTo("text/plain")
        assertThat(file.lastModified).isEqualTo(1700000000000L)
        assertThat(file.isDirectory).isFalse()
    }

    // ==================== Read Files ====================

    @Test
    fun `reads file content`() {
        documentTree.addFile("test.txt", "Hello, World!".toByteArray(), "text/plain")

        val content = fileService.readFile("test.txt")

        assertThat(content.decodeToString()).isEqualTo("Hello, World!")
    }

    @Test
    fun `reads binary file content`() {
        val binaryData = byteArrayOf(0x00, 0x01, 0x02, 0xFF.toByte(), 0xFE.toByte())
        documentTree.addFile("data.bin", binaryData, "application/octet-stream")

        val content = fileService.readFile("data.bin")

        assertThat(content).isEqualTo(binaryData)
    }

    @Test
    fun `reads large file content`() {
        val largeContent = ByteArray(1024 * 1024) { (it % 256).toByte() } // 1 MB
        documentTree.addFile("large.bin", largeContent, "application/octet-stream")

        val content = fileService.readFile("large.bin")

        assertThat(content).isEqualTo(largeContent)
    }

    @Test
    fun `throws when reading non-existent file`() {
        assertThrows<FileNotFoundException> {
            fileService.readFile("non-existent.txt")
        }
    }

    @Test
    fun `reads file from subdirectory`() {
        documentTree.addDirectory("docs")
        documentTree.addFileInDirectory("docs", "readme.txt", "Read me!".toByteArray(), "text/plain")

        val content = fileService.readFile("docs/readme.txt")

        assertThat(content.decodeToString()).isEqualTo("Read me!")
    }

    // ==================== Write Files ====================

    @Test
    fun `writes new file`() {
        fileService.writeFile("new-file.txt", "New content".toByteArray(), "text/plain")

        val content = fileService.readFile("new-file.txt")
        assertThat(content.decodeToString()).isEqualTo("New content")
    }

    @Test
    fun `overwrites existing file`() {
        documentTree.addFile("existing.txt", "Old content".toByteArray(), "text/plain")

        fileService.writeFile("existing.txt", "New content".toByteArray(), "text/plain")

        val content = fileService.readFile("existing.txt")
        assertThat(content.decodeToString()).isEqualTo("New content")
    }

    @Test
    fun `writes binary file`() {
        val binaryData = byteArrayOf(0x00, 0x01, 0xFF.toByte())

        fileService.writeFile("data.bin", binaryData, "application/octet-stream")

        val content = fileService.readFile("data.bin")
        assertThat(content).isEqualTo(binaryData)
    }

    @Test
    fun `writes file in subdirectory`() {
        documentTree.addDirectory("docs")

        fileService.writeFile("docs/new.txt", "Content".toByteArray(), "text/plain")

        val content = fileService.readFile("docs/new.txt")
        assertThat(content.decodeToString()).isEqualTo("Content")
    }

    @Test
    fun `throws when writing to non-existent directory`() {
        assertThrows<FileNotFoundException> {
            fileService.writeFile("non-existent-dir/file.txt", "Content".toByteArray(), "text/plain")
        }
    }

    // ==================== Delete Files ====================

    @Test
    fun `deletes file`() {
        documentTree.addFile("to-delete.txt", "Delete me".toByteArray(), "text/plain")

        val deleted = fileService.deleteFile("to-delete.txt")

        assertThat(deleted).isTrue()
        assertThrows<FileNotFoundException> {
            fileService.readFile("to-delete.txt")
        }
    }

    @Test
    fun `returns false when deleting non-existent file`() {
        val deleted = fileService.deleteFile("non-existent.txt")

        assertThat(deleted).isFalse()
    }

    @Test
    fun `deletes directory`() {
        documentTree.addDirectory("empty-dir")

        val deleted = fileService.deleteFile("empty-dir")

        assertThat(deleted).isTrue()
    }

    // ==================== Create Directory ====================

    @Test
    fun `creates directory`() {
        fileService.createDirectory("new-dir")

        val files = fileService.listFiles()
        val newDir = files.find { it.name == "new-dir" }

        assertThat(newDir).isNotNull()
        assertThat(newDir!!.isDirectory).isTrue()
    }

    @Test
    fun `creates nested directory`() {
        documentTree.addDirectory("parent")

        fileService.createDirectory("parent/child")

        val parentFiles = fileService.listFilesInDirectory("parent")
        val childDir = parentFiles.find { it.name == "child" }

        assertThat(childDir).isNotNull()
        assertThat(childDir!!.isDirectory).isTrue()
    }

    // ==================== Permission Handling ====================

    @Test
    fun `throws on list when access denied`() {
        documentTree.setReadable(false)

        assertThrows<FileAccessDeniedException> {
            fileService.listFiles()
        }
    }

    @Test
    fun `throws on read when access denied`() {
        documentTree.addFile("test.txt", "Content".toByteArray(), "text/plain")
        documentTree.setReadable(false)

        assertThrows<FileAccessDeniedException> {
            fileService.readFile("test.txt")
        }
    }

    @Test
    fun `throws on write when access denied`() {
        documentTree.setWritable(false)

        assertThrows<FileAccessDeniedException> {
            fileService.writeFile("test.txt", "Content".toByteArray(), "text/plain")
        }
    }

    // ==================== File Info ====================

    @Test
    fun `gets file info`() {
        val content = "Test content".toByteArray()
        documentTree.addFile("info.txt", content, "text/plain", lastModified = 1700000000000L)

        val info = fileService.getFileInfo("info.txt")

        assertThat(info).isNotNull()
        assertThat(info!!.name).isEqualTo("info.txt")
        assertThat(info.size).isEqualTo(content.size.toLong())
        assertThat(info.mimeType).isEqualTo("text/plain")
        assertThat(info.lastModified).isEqualTo(1700000000000L)
    }

    @Test
    fun `returns null for non-existent file info`() {
        val info = fileService.getFileInfo("non-existent.txt")

        assertThat(info).isNull()
    }

    // ==================== Exists Check ====================

    @Test
    fun `checks file exists`() {
        documentTree.addFile("exists.txt", "Content".toByteArray(), "text/plain")

        assertThat(fileService.exists("exists.txt")).isTrue()
        assertThat(fileService.exists("not-exists.txt")).isFalse()
    }

    @Test
    fun `checks directory exists`() {
        documentTree.addDirectory("my-dir")

        assertThat(fileService.exists("my-dir")).isTrue()
        assertThat(fileService.exists("other-dir")).isFalse()
    }

    // ==================== Rename/Move ====================

    @Test
    fun `renames file`() {
        documentTree.addFile("old-name.txt", "Content".toByteArray(), "text/plain")

        val renamed = fileService.rename("old-name.txt", "new-name.txt")

        assertThat(renamed).isTrue()
        assertThat(fileService.exists("old-name.txt")).isFalse()
        assertThat(fileService.exists("new-name.txt")).isTrue()
        assertThat(fileService.readFile("new-name.txt").decodeToString()).isEqualTo("Content")
    }

    @Test
    fun `returns false when renaming non-existent file`() {
        val renamed = fileService.rename("non-existent.txt", "new-name.txt")

        assertThat(renamed).isFalse()
    }
}
