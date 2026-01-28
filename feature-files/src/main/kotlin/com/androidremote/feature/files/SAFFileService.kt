package com.androidremote.feature.files

/**
 * File service using Storage Access Framework.
 *
 * Provides file operations within a granted document tree.
 * Users must first grant access to a directory via the system picker,
 * then this service can operate within that scope.
 *
 * @property documentTree The document tree to operate on
 */
class SAFFileService(
    private val documentTree: DocumentTree
) {
    /**
     * List all files and directories in the root of the granted tree.
     *
     * @return List of file information
     * @throws FileAccessDeniedException if read access is denied
     */
    fun listFiles(): List<FileInfo> {
        checkReadAccess()
        return documentTree.listFiles().map { it.toFileInfo() }
    }

    /**
     * List files in a specific directory within the tree.
     *
     * @param path Path to the directory
     * @return List of file information
     * @throws FileAccessDeniedException if read access is denied
     */
    fun listFilesInDirectory(path: String): List<FileInfo> {
        checkReadAccess()
        return documentTree.listFiles(path).map { it.toFileInfo() }
    }

    /**
     * Read file content.
     *
     * @param path Path to the file
     * @return File content as byte array
     * @throws FileNotFoundException if file doesn't exist
     * @throws FileAccessDeniedException if read access is denied
     */
    fun readFile(path: String): ByteArray {
        checkReadAccess()
        return documentTree.readFile(path)
    }

    /**
     * Write content to a file.
     * Creates the file if it doesn't exist, overwrites if it does.
     *
     * @param path Path to the file
     * @param content Content to write
     * @param mimeType MIME type of the content
     * @throws FileNotFoundException if parent directory doesn't exist
     * @throws FileAccessDeniedException if write access is denied
     */
    fun writeFile(path: String, content: ByteArray, mimeType: String) {
        checkWriteAccess()
        documentTree.writeFile(path, content, mimeType)
    }

    /**
     * Delete a file or directory.
     *
     * @param path Path to the file or directory
     * @return true if deleted, false if not found
     * @throws FileAccessDeniedException if write access is denied
     */
    fun deleteFile(path: String): Boolean {
        checkWriteAccess()
        return documentTree.delete(path)
    }

    /**
     * Create a directory.
     *
     * @param path Path for the new directory
     * @throws FileAccessDeniedException if write access is denied
     */
    fun createDirectory(path: String) {
        checkWriteAccess()
        documentTree.createDirectory(path)
    }

    /**
     * Get information about a file or directory.
     *
     * @param path Path to the file or directory
     * @return File information, or null if not found
     * @throws FileAccessDeniedException if read access is denied
     */
    fun getFileInfo(path: String): FileInfo? {
        checkReadAccess()
        return documentTree.findNode(path)?.toFileInfo()
    }

    /**
     * Check if a file or directory exists.
     *
     * @param path Path to check
     * @return true if exists, false otherwise
     * @throws FileAccessDeniedException if read access is denied
     */
    fun exists(path: String): Boolean {
        checkReadAccess()
        return documentTree.findNode(path) != null
    }

    /**
     * Rename a file or directory.
     *
     * @param path Current path
     * @param newName New name (not full path, just the name)
     * @return true if renamed, false if not found
     * @throws FileAccessDeniedException if write access is denied
     */
    fun rename(path: String, newName: String): Boolean {
        checkWriteAccess()
        return documentTree.rename(path, newName)
    }

    private fun checkReadAccess() {
        if (!documentTree.canRead()) {
            throw FileAccessDeniedException("Read access denied to document tree")
        }
    }

    private fun checkWriteAccess() {
        if (!documentTree.canWrite()) {
            throw FileAccessDeniedException("Write access denied to document tree")
        }
    }

    private fun DocumentNode.toFileInfo(): FileInfo {
        return FileInfo(
            name = name,
            size = size,
            mimeType = mimeType,
            lastModified = lastModified,
            isDirectory = isDirectory
        )
    }
}
