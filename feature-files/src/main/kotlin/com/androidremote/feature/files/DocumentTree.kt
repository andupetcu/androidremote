package com.androidremote.feature.files

/**
 * Abstraction over Android's DocumentFile for testability.
 *
 * This interface allows unit testing file operations without
 * needing actual Android framework access. In production, this
 * is implemented by a wrapper around DocumentFile.
 */
interface DocumentTree {
    /**
     * Check if the tree is readable.
     */
    fun canRead(): Boolean

    /**
     * Check if the tree is writable.
     */
    fun canWrite(): Boolean

    /**
     * List all files and directories in the root.
     */
    fun listFiles(): List<DocumentNode>

    /**
     * List files in a specific directory path.
     */
    fun listFiles(path: String): List<DocumentNode>

    /**
     * Find a node by path.
     */
    fun findNode(path: String): DocumentNode?

    /**
     * Read content from a file path.
     */
    fun readFile(path: String): ByteArray

    /**
     * Write content to a file path.
     * Creates the file if it doesn't exist, overwrites if it does.
     */
    fun writeFile(path: String, content: ByteArray, mimeType: String)

    /**
     * Delete a file or directory.
     */
    fun delete(path: String): Boolean

    /**
     * Create a directory.
     */
    fun createDirectory(path: String): Boolean

    /**
     * Rename a file or directory.
     */
    fun rename(oldPath: String, newName: String): Boolean
}

/**
 * Represents a file or directory in the document tree.
 */
data class DocumentNode(
    val name: String,
    val size: Long,
    val mimeType: String,
    val lastModified: Long,
    val isDirectory: Boolean
)
