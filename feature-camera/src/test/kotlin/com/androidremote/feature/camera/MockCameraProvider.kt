package com.androidremote.feature.camera

/**
 * Mock implementation of CameraProvider for unit testing.
 *
 * Simulates camera operations without actual hardware.
 */
class MockCameraProvider : CameraProvider {

    private val cameras = mutableListOf<CameraInfo>()
    private var currentCamera: CameraInfo? = null
    private var onFrameCallback: ((VideoFrame) -> Unit)? = null
    private var capturing = false
    private var flashEnabled = false
    private var configuredWidth = 1280
    private var configuredHeight = 720
    private var configuredFrameRate = 30
    private var frameWidth = 1280
    private var frameHeight = 720
    private var frameSizeExplicitlySet = false
    private var frameTimestamp = 0L

    fun addCamera(camera: CameraInfo) {
        cameras.add(camera)
    }

    fun setFrameSize(width: Int, height: Int) {
        frameWidth = width
        frameHeight = height
        frameSizeExplicitlySet = true
    }

    fun emitFrames(count: Int) {
        if (!capturing) return

        repeat(count) {
            frameTimestamp += 33_333_333L // ~30fps interval
            val frame = VideoFrame(
                width = frameWidth,
                height = frameHeight,
                data = ByteArray(frameWidth * frameHeight * 3 / 2), // YUV420
                timestampNs = frameTimestamp
            )
            onFrameCallback?.invoke(frame)
        }
    }

    override fun getAvailableCameras(): List<CameraInfo> = cameras.toList()

    override fun openCamera(cameraId: String, onFrame: (VideoFrame) -> Unit) {
        val camera = cameras.find { it.id == cameraId }
            ?: throw CameraNotFoundException("Camera not found: $cameraId")

        currentCamera = camera
        onFrameCallback = onFrame
        flashEnabled = false
    }

    override fun closeCamera() {
        capturing = false
        currentCamera = null
        onFrameCallback = null
        flashEnabled = false
    }

    override fun isOpen(): Boolean = currentCamera != null

    override fun getCurrentCamera(): CameraInfo? = currentCamera

    override fun startCapture() {
        capturing = true
        // Update frame size to match configured resolution (unless explicitly set for testing)
        if (!frameSizeExplicitlySet) {
            frameWidth = configuredWidth
            frameHeight = configuredHeight
        }
    }

    override fun stopCapture() {
        capturing = false
    }

    override fun isCapturing(): Boolean = capturing

    override fun setFlash(enabled: Boolean): Boolean {
        val camera = currentCamera ?: return false
        if (!camera.hasFlash) return false
        flashEnabled = enabled
        return true
    }

    override fun isFlashEnabled(): Boolean = flashEnabled

    override fun setResolution(width: Int, height: Int) {
        configuredWidth = width
        configuredHeight = height
    }

    override fun getConfiguredWidth(): Int = configuredWidth

    override fun getConfiguredHeight(): Int = configuredHeight

    override fun setFrameRate(fps: Int) {
        configuredFrameRate = fps
    }

    override fun getConfiguredFrameRate(): Int = configuredFrameRate
}
