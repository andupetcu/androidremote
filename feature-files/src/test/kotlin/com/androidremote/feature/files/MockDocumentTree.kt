package com.androidremote.feature.files

/**
 * Mock implementation of DocumentTree for unit testing.
 *
 * Simulates a file system in memory without requiring Android framework.
 */
class MockDocumentTree : DocumentTree {

    private data class MockFile(
        val name: String,
        var content: ByteArray,
        val mimeType: String,
        val lastModified: Long,
        val isDirectory: Boolean
    )

    private val files = mutableMapOf<String, MockFile>()
    private var readable = true
    private var writable = true

    fun setReadable(readable: Boolean) {
        this.readable = readable
    }

    fun setWritable(writable: Boolean) {
        this.writable = writable
    }

    fun addFile(name: String, content: ByteArray, mimeType: String, lastModified: Long = System.currentTimeMillis()) {
        files[name] = MockFile(name, content, mimeType, lastModified, isDirectory = false)
    }

    fun addDirectory(name: String) {
        files[name] = MockFile(name, ByteArray(0), "inode/directory", System.currentTimeMillis(), isDirectory = true)
    }

    fun addFileInDirectory(directory: String, name: String, content: ByteArray, mimeType: String, lastModified: Long = System.currentTimeMillis()) {
        val path = "$directory/$name"
        files[path] = MockFile(name, content, mimeType, lastModified, isDirectory = false)
    }

    override fun canRead(): Boolean = readable

    override fun canWrite(): Boolean = writable

    override fun listFiles(): List<DocumentNode> {
        return files.filterKeys { !it.contains('/') }
            .map { (_, file) ->
                DocumentNode(
                    name = file.name,
                    size = file.content.size.toLong(),
                    mimeType = file.mimeType,
                    lastModified = file.lastModified,
                    isDirectory = file.isDirectory
                )
            }
    }

    override fun listFiles(path: String): List<DocumentNode> {
        val prefix = if (path.endsWith("/")) path else "$path/"
        return files.filterKeys { it.startsWith(prefix) && !it.substring(prefix.length).contains('/') }
            .map { (_, file) ->
                DocumentNode(
                    name = file.name,
                    size = file.content.size.toLong(),
                    mimeType = file.mimeType,
                    lastModified = file.lastModified,
                    isDirectory = file.isDirectory
                )
            }
    }

    override fun findNode(path: String): DocumentNode? {
        val file = files[path] ?: return null
        return DocumentNode(
            name = file.name,
            size = file.content.size.toLong(),
            mimeType = file.mimeType,
            lastModified = file.lastModified,
            isDirectory = file.isDirectory
        )
    }

    override fun readFile(path: String): ByteArray {
        val file = files[path] ?: throw FileNotFoundException("File not found: $path")
        return file.content.copyOf()
    }

    override fun writeFile(path: String, content: ByteArray, mimeType: String) {
        // Check if parent directory exists for nested paths
        if (path.contains('/')) {
            val parentPath = path.substringBeforeLast('/')
            val parent = files[parentPath]
            if (parent == null || !parent.isDirectory) {
                throw FileNotFoundException("Parent directory not found: $parentPath")
            }
        }

        val name = path.substringAfterLast('/')
        val existingFile = files[path]
        if (existingFile != null) {
            // Overwrite existing file
            files[path] = existingFile.copy(content = content)
        } else {
            // Create new file
            files[path] = MockFile(name, content, mimeType, System.currentTimeMillis(), isDirectory = false)
        }
    }

    override fun delete(path: String): Boolean {
        return files.remove(path) != null
    }

    override fun createDirectory(path: String): Boolean {
        // Check if parent directory exists for nested paths
        if (path.contains('/')) {
            val parentPath = path.substringBeforeLast('/')
            val parent = files[parentPath]
            if (parent == null || !parent.isDirectory) {
                return false
            }
        }

        val name = path.substringAfterLast('/')
        files[path] = MockFile(name, ByteArray(0), "inode/directory", System.currentTimeMillis(), isDirectory = true)
        return true
    }

    override fun rename(oldPath: String, newName: String): Boolean {
        val file = files.remove(oldPath) ?: return false
        val newPath = if (oldPath.contains('/')) {
            oldPath.substringBeforeLast('/') + "/" + newName
        } else {
            newName
        }
        files[newPath] = file.copy(name = newName)
        return true
    }
}
