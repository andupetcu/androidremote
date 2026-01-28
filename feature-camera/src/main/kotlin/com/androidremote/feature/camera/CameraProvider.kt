package com.androidremote.feature.camera

/**
 * Abstraction over Android's Camera2 API for testability.
 *
 * This interface allows unit testing camera operations without
 * needing actual hardware. In production, this is implemented
 * by a wrapper around CameraManager.
 */
interface CameraProvider {
    /**
     * Get list of available cameras.
     */
    fun getAvailableCameras(): List<CameraInfo>

    /**
     * Open a camera by ID.
     *
     * @param cameraId The camera to open
     * @param onFrame Callback for received frames
     * @throws CameraNotFoundException if camera not found
     */
    fun openCamera(cameraId: String, onFrame: (VideoFrame) -> Unit)

    /**
     * Close the currently open camera.
     */
    fun closeCamera()

    /**
     * Check if a camera is currently open.
     */
    fun isOpen(): Boolean

    /**
     * Get the currently open camera info.
     */
    fun getCurrentCamera(): CameraInfo?

    /**
     * Start frame capture.
     */
    fun startCapture()

    /**
     * Stop frame capture.
     */
    fun stopCapture()

    /**
     * Check if capture is active.
     */
    fun isCapturing(): Boolean

    /**
     * Set flash mode.
     *
     * @param enabled Whether to enable flash
     * @return true if flash was set, false if not supported
     */
    fun setFlash(enabled: Boolean): Boolean

    /**
     * Check if flash is enabled.
     */
    fun isFlashEnabled(): Boolean

    /**
     * Configure capture resolution.
     */
    fun setResolution(width: Int, height: Int)

    /**
     * Get configured width.
     */
    fun getConfiguredWidth(): Int

    /**
     * Get configured height.
     */
    fun getConfiguredHeight(): Int

    /**
     * Configure frame rate.
     */
    fun setFrameRate(fps: Int)

    /**
     * Get configured frame rate.
     */
    fun getConfiguredFrameRate(): Int
}
