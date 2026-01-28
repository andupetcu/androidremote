package com.androidremote.feature.files

/**
 * Information about a file or directory.
 *
 * @property name File or directory name
 * @property size Size in bytes (0 for directories)
 * @property mimeType MIME type of the file
 * @property lastModified Last modification timestamp in milliseconds
 * @property isDirectory Whether this is a directory
 * @property uri Optional URI for accessing the file
 */
data class FileInfo(
    val name: String,
    val size: Long,
    val mimeType: String,
    val lastModified: Long,
    val isDirectory: Boolean,
    val uri: String? = null
)

/**
 * Exception thrown when a file is not found.
 */
class FileNotFoundException(message: String) : Exception(message)

/**
 * Exception thrown when file access is denied.
 */
class FileAccessDeniedException(message: String) : Exception(message)
