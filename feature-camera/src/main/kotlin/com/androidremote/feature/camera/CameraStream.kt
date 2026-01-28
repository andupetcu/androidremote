package com.androidremote.feature.camera

/**
 * Camera streaming service for remote viewing.
 *
 * Provides access to device cameras for streaming video frames
 * to the encoder. Handles camera selection, switching, and
 * capture configuration.
 *
 * @property cameraProvider The camera provider implementation
 */
class CameraStream(
    private val cameraProvider: CameraProvider
) {
    /**
     * Callback for received video frames.
     */
    var onFrame: ((VideoFrame) -> Unit)? = null

    private var capturing = false

    /**
     * Get list of available cameras.
     */
    fun getAvailableCameras(): List<CameraInfo> {
        return cameraProvider.getAvailableCameras()
    }

    /**
     * Get the back-facing camera, if available.
     */
    fun getBackCamera(): CameraInfo? {
        return cameraProvider.getAvailableCameras()
            .find { it.facing == CameraFacing.BACK }
    }

    /**
     * Get the front-facing camera, if available.
     */
    fun getFrontCamera(): CameraInfo? {
        return cameraProvider.getAvailableCameras()
            .find { it.facing == CameraFacing.FRONT }
    }

    /**
     * Open a camera.
     *
     * If no camera ID is specified, opens back camera by default,
     * or front camera if back is not available.
     *
     * @param cameraId Specific camera to open, or null for default
     * @throws CameraNotFoundException if specified camera not found
     * @throws CameraNotFoundException if no cameras available
     */
    fun open(cameraId: String? = null) {
        val id = cameraId ?: run {
            val cameras = cameraProvider.getAvailableCameras()
            if (cameras.isEmpty()) {
                throw CameraNotFoundException("No cameras available")
            }
            // Prefer back camera, fall back to first available
            cameras.find { it.facing == CameraFacing.BACK }?.id
                ?: cameras.first().id
        }

        cameraProvider.openCamera(id) { frame ->
            if (capturing) {
                onFrame?.invoke(frame)
            }
        }
    }

    /**
     * Check if camera is open.
     */
    fun isOpen(): Boolean = cameraProvider.isOpen()

    /**
     * Get the currently open camera.
     */
    fun getCurrentCamera(): CameraInfo? = cameraProvider.getCurrentCamera()

    /**
     * Switch between front and back cameras.
     *
     * If currently using back camera, switches to front, and vice versa.
     * Does nothing if only one camera is available.
     *
     * @throws CameraNotOpenException if no camera is open
     */
    fun switchCamera() {
        val current = cameraProvider.getCurrentCamera()
            ?: throw CameraNotOpenException("No camera is open")

        val cameras = cameraProvider.getAvailableCameras()
        if (cameras.size <= 1) return

        val targetFacing = when (current.facing) {
            CameraFacing.BACK -> CameraFacing.FRONT
            CameraFacing.FRONT -> CameraFacing.BACK
            CameraFacing.EXTERNAL -> CameraFacing.BACK
        }

        val targetCamera = cameras.find { it.facing == targetFacing }
            ?: return // No camera with target facing

        val wasCapturing = capturing
        if (wasCapturing) {
            stopCapture()
        }

        cameraProvider.closeCamera()
        cameraProvider.openCamera(targetCamera.id) { frame ->
            if (capturing) {
                onFrame?.invoke(frame)
            }
        }

        if (wasCapturing) {
            startCapture()
        }
    }

    /**
     * Start capturing video frames.
     *
     * Frames will be delivered via the onFrame callback.
     *
     * @throws CameraNotOpenException if no camera is open
     */
    fun startCapture() {
        if (!cameraProvider.isOpen()) {
            throw CameraNotOpenException("No camera is open")
        }

        if (capturing) return // Already capturing

        capturing = true
        cameraProvider.startCapture()
    }

    /**
     * Stop capturing video frames.
     */
    fun stopCapture() {
        capturing = false
        if (cameraProvider.isCapturing()) {
            cameraProvider.stopCapture()
        }
    }

    /**
     * Close the camera.
     */
    fun close() {
        capturing = false
        if (cameraProvider.isOpen()) {
            cameraProvider.closeCamera()
        }
    }

    /**
     * Enable or disable flash.
     *
     * @param enabled Whether to enable flash
     * @return true if flash was set, false if not supported
     * @throws CameraNotOpenException if no camera is open
     */
    fun setFlash(enabled: Boolean): Boolean {
        if (!cameraProvider.isOpen()) {
            throw CameraNotOpenException("No camera is open")
        }
        return cameraProvider.setFlash(enabled)
    }

    /**
     * Check if flash is currently enabled.
     */
    fun isFlashEnabled(): Boolean = cameraProvider.isFlashEnabled()

    /**
     * Set capture resolution.
     *
     * @param width Width in pixels
     * @param height Height in pixels
     */
    fun setResolution(width: Int, height: Int) {
        cameraProvider.setResolution(width, height)
    }

    /**
     * Set capture frame rate.
     *
     * @param fps Frames per second
     */
    fun setFrameRate(fps: Int) {
        cameraProvider.setFrameRate(fps)
    }
}
