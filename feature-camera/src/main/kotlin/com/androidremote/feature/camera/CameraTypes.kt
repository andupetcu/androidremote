package com.androidremote.feature.camera

/**
 * Camera facing direction.
 */
enum class CameraFacing {
    FRONT,
    BACK,
    EXTERNAL
}

/**
 * Information about a camera.
 *
 * @property id Unique identifier for the camera
 * @property facing Which direction the camera faces
 * @property hasFlash Whether the camera has a flash
 */
data class CameraInfo(
    val id: String,
    val facing: CameraFacing,
    val hasFlash: Boolean
)

/**
 * A video frame from camera capture.
 *
 * @property width Frame width in pixels
 * @property height Frame height in pixels
 * @property data Raw pixel data
 * @property timestampNs Capture timestamp in nanoseconds
 */
data class VideoFrame(
    val width: Int,
    val height: Int,
    val data: ByteArray,
    val timestampNs: Long
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (javaClass != other?.javaClass) return false
        other as VideoFrame
        return width == other.width &&
                height == other.height &&
                data.contentEquals(other.data) &&
                timestampNs == other.timestampNs
    }

    override fun hashCode(): Int {
        var result = width
        result = 31 * result + height
        result = 31 * result + data.contentHashCode()
        result = 31 * result + timestampNs.hashCode()
        return result
    }
}

/**
 * Exception thrown when camera is not found.
 */
class CameraNotFoundException(message: String) : Exception(message)

/**
 * Exception thrown when camera operation requires open camera.
 */
class CameraNotOpenException(message: String) : Exception(message)
