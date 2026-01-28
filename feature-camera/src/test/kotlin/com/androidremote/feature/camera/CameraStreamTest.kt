package com.androidremote.feature.camera

import com.google.common.truth.Truth.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.assertThrows

/**
 * Tests for camera streaming functionality.
 *
 * The CameraStream provides access to device cameras for streaming
 * video to remote viewers. It abstracts over Android's Camera2 API
 * to enable unit testing without hardware.
 *
 * These tests are written FIRST (TDD) - implementation follows.
 */
class CameraStreamTest {

    private lateinit var mockCameraProvider: MockCameraProvider
    private lateinit var cameraStream: CameraStream

    @BeforeEach
    fun setUp() {
        mockCameraProvider = MockCameraProvider()
        cameraStream = CameraStream(mockCameraProvider)
    }

    // ==================== Camera Discovery ====================

    @Test
    fun `discovers available cameras`() {
        mockCameraProvider.addCamera(CameraInfo("0", CameraFacing.BACK, hasFlash = true))
        mockCameraProvider.addCamera(CameraInfo("1", CameraFacing.FRONT, hasFlash = false))

        val cameras = cameraStream.getAvailableCameras()

        assertThat(cameras).hasSize(2)
        assertThat(cameras[0].facing).isEqualTo(CameraFacing.BACK)
        assertThat(cameras[1].facing).isEqualTo(CameraFacing.FRONT)
    }

    @Test
    fun `returns empty list when no cameras available`() {
        val cameras = cameraStream.getAvailableCameras()

        assertThat(cameras).isEmpty()
    }

    @Test
    fun `identifies back camera`() {
        mockCameraProvider.addCamera(CameraInfo("0", CameraFacing.BACK, hasFlash = true))
        mockCameraProvider.addCamera(CameraInfo("1", CameraFacing.FRONT, hasFlash = false))

        val backCamera = cameraStream.getBackCamera()

        assertThat(backCamera).isNotNull()
        assertThat(backCamera!!.facing).isEqualTo(CameraFacing.BACK)
    }

    @Test
    fun `identifies front camera`() {
        mockCameraProvider.addCamera(CameraInfo("0", CameraFacing.BACK, hasFlash = true))
        mockCameraProvider.addCamera(CameraInfo("1", CameraFacing.FRONT, hasFlash = false))

        val frontCamera = cameraStream.getFrontCamera()

        assertThat(frontCamera).isNotNull()
        assertThat(frontCamera!!.facing).isEqualTo(CameraFacing.FRONT)
    }

    // ==================== Camera Opening ====================

    @Test
    fun `opens back camera by default`() {
        mockCameraProvider.addCamera(CameraInfo("0", CameraFacing.BACK, hasFlash = true))
        mockCameraProvider.addCamera(CameraInfo("1", CameraFacing.FRONT, hasFlash = false))

        cameraStream.open()

        assertThat(cameraStream.isOpen()).isTrue()
        assertThat(cameraStream.getCurrentCamera()?.facing).isEqualTo(CameraFacing.BACK)
    }

    @Test
    fun `opens front camera when back not available`() {
        mockCameraProvider.addCamera(CameraInfo("1", CameraFacing.FRONT, hasFlash = false))

        cameraStream.open()

        assertThat(cameraStream.isOpen()).isTrue()
        assertThat(cameraStream.getCurrentCamera()?.facing).isEqualTo(CameraFacing.FRONT)
    }

    @Test
    fun `opens specific camera by id`() {
        mockCameraProvider.addCamera(CameraInfo("0", CameraFacing.BACK, hasFlash = true))
        mockCameraProvider.addCamera(CameraInfo("1", CameraFacing.FRONT, hasFlash = false))

        cameraStream.open(cameraId = "1")

        assertThat(cameraStream.getCurrentCamera()?.id).isEqualTo("1")
        assertThat(cameraStream.getCurrentCamera()?.facing).isEqualTo(CameraFacing.FRONT)
    }

    @Test
    fun `throws when opening non-existent camera`() {
        mockCameraProvider.addCamera(CameraInfo("0", CameraFacing.BACK, hasFlash = true))

        assertThrows<CameraNotFoundException> {
            cameraStream.open(cameraId = "99")
        }
    }

    @Test
    fun `throws when no cameras available`() {
        assertThrows<CameraNotFoundException> {
            cameraStream.open()
        }
    }

    // ==================== Camera Switching ====================

    @Test
    fun `switches from back to front camera`() {
        mockCameraProvider.addCamera(CameraInfo("0", CameraFacing.BACK, hasFlash = true))
        mockCameraProvider.addCamera(CameraInfo("1", CameraFacing.FRONT, hasFlash = false))
        cameraStream.open() // Opens back by default

        cameraStream.switchCamera()

        assertThat(cameraStream.getCurrentCamera()?.facing).isEqualTo(CameraFacing.FRONT)
    }

    @Test
    fun `switches from front to back camera`() {
        mockCameraProvider.addCamera(CameraInfo("0", CameraFacing.BACK, hasFlash = true))
        mockCameraProvider.addCamera(CameraInfo("1", CameraFacing.FRONT, hasFlash = false))
        cameraStream.open(cameraId = "1") // Open front

        cameraStream.switchCamera()

        assertThat(cameraStream.getCurrentCamera()?.facing).isEqualTo(CameraFacing.BACK)
    }

    @Test
    fun `switch does nothing with single camera`() {
        mockCameraProvider.addCamera(CameraInfo("0", CameraFacing.BACK, hasFlash = true))
        cameraStream.open()

        cameraStream.switchCamera()

        assertThat(cameraStream.getCurrentCamera()?.facing).isEqualTo(CameraFacing.BACK)
    }

    @Test
    fun `throws when switching without opening`() {
        mockCameraProvider.addCamera(CameraInfo("0", CameraFacing.BACK, hasFlash = true))
        mockCameraProvider.addCamera(CameraInfo("1", CameraFacing.FRONT, hasFlash = false))

        assertThrows<CameraNotOpenException> {
            cameraStream.switchCamera()
        }
    }

    // ==================== Frame Capture ====================

    @Test
    fun `starts capture and receives frames`() {
        mockCameraProvider.addCamera(CameraInfo("0", CameraFacing.BACK, hasFlash = true))
        cameraStream.open()
        val receivedFrames = mutableListOf<VideoFrame>()
        cameraStream.onFrame = { receivedFrames.add(it) }

        cameraStream.startCapture()
        mockCameraProvider.emitFrames(5)

        assertThat(receivedFrames).hasSize(5)
    }

    @Test
    fun `frames have correct dimensions`() {
        mockCameraProvider.addCamera(CameraInfo("0", CameraFacing.BACK, hasFlash = true))
        mockCameraProvider.setFrameSize(1920, 1080)
        cameraStream.open()
        var capturedFrame: VideoFrame? = null
        cameraStream.onFrame = { capturedFrame = it }

        cameraStream.startCapture()
        mockCameraProvider.emitFrames(1)

        assertThat(capturedFrame).isNotNull()
        assertThat(capturedFrame!!.width).isEqualTo(1920)
        assertThat(capturedFrame!!.height).isEqualTo(1080)
    }

    @Test
    fun `frames have increasing timestamps`() {
        mockCameraProvider.addCamera(CameraInfo("0", CameraFacing.BACK, hasFlash = true))
        cameraStream.open()
        val timestamps = mutableListOf<Long>()
        cameraStream.onFrame = { timestamps.add(it.timestampNs) }

        cameraStream.startCapture()
        mockCameraProvider.emitFrames(3)

        assertThat(timestamps).hasSize(3)
        assertThat(timestamps[1]).isGreaterThan(timestamps[0])
        assertThat(timestamps[2]).isGreaterThan(timestamps[1])
    }

    @Test
    fun `stops capture`() {
        mockCameraProvider.addCamera(CameraInfo("0", CameraFacing.BACK, hasFlash = true))
        cameraStream.open()
        val receivedFrames = mutableListOf<VideoFrame>()
        cameraStream.onFrame = { receivedFrames.add(it) }
        cameraStream.startCapture()
        mockCameraProvider.emitFrames(2)

        cameraStream.stopCapture()
        mockCameraProvider.emitFrames(3) // These should be ignored

        assertThat(receivedFrames).hasSize(2)
    }

    @Test
    fun `throws when starting capture without opening`() {
        mockCameraProvider.addCamera(CameraInfo("0", CameraFacing.BACK, hasFlash = true))

        assertThrows<CameraNotOpenException> {
            cameraStream.startCapture()
        }
    }

    @Test
    fun `capture is idempotent - multiple starts do not duplicate frames`() {
        mockCameraProvider.addCamera(CameraInfo("0", CameraFacing.BACK, hasFlash = true))
        cameraStream.open()
        val receivedFrames = mutableListOf<VideoFrame>()
        cameraStream.onFrame = { receivedFrames.add(it) }

        cameraStream.startCapture()
        cameraStream.startCapture() // Second start should be no-op
        mockCameraProvider.emitFrames(2)

        assertThat(receivedFrames).hasSize(2)
    }

    // ==================== Camera Closing ====================

    @Test
    fun `closes camera`() {
        mockCameraProvider.addCamera(CameraInfo("0", CameraFacing.BACK, hasFlash = true))
        cameraStream.open()

        cameraStream.close()

        assertThat(cameraStream.isOpen()).isFalse()
        assertThat(cameraStream.getCurrentCamera()).isNull()
    }

    @Test
    fun `close stops capture`() {
        mockCameraProvider.addCamera(CameraInfo("0", CameraFacing.BACK, hasFlash = true))
        cameraStream.open()
        val receivedFrames = mutableListOf<VideoFrame>()
        cameraStream.onFrame = { receivedFrames.add(it) }
        cameraStream.startCapture()
        mockCameraProvider.emitFrames(2)

        cameraStream.close()
        mockCameraProvider.emitFrames(3)

        assertThat(receivedFrames).hasSize(2)
    }

    @Test
    fun `close is idempotent`() {
        mockCameraProvider.addCamera(CameraInfo("0", CameraFacing.BACK, hasFlash = true))
        cameraStream.open()

        cameraStream.close()
        cameraStream.close() // Should not throw

        assertThat(cameraStream.isOpen()).isFalse()
    }

    @Test
    fun `can reopen after close`() {
        mockCameraProvider.addCamera(CameraInfo("0", CameraFacing.BACK, hasFlash = true))
        cameraStream.open()
        cameraStream.close()

        cameraStream.open()

        assertThat(cameraStream.isOpen()).isTrue()
    }

    // ==================== Flash Control ====================

    @Test
    fun `enables flash on camera with flash`() {
        mockCameraProvider.addCamera(CameraInfo("0", CameraFacing.BACK, hasFlash = true))
        cameraStream.open()

        val result = cameraStream.setFlash(true)

        assertThat(result).isTrue()
        assertThat(cameraStream.isFlashEnabled()).isTrue()
    }

    @Test
    fun `disables flash`() {
        mockCameraProvider.addCamera(CameraInfo("0", CameraFacing.BACK, hasFlash = true))
        cameraStream.open()
        cameraStream.setFlash(true)

        cameraStream.setFlash(false)

        assertThat(cameraStream.isFlashEnabled()).isFalse()
    }

    @Test
    fun `flash returns false on camera without flash`() {
        mockCameraProvider.addCamera(CameraInfo("1", CameraFacing.FRONT, hasFlash = false))
        cameraStream.open()

        val result = cameraStream.setFlash(true)

        assertThat(result).isFalse()
        assertThat(cameraStream.isFlashEnabled()).isFalse()
    }

    @Test
    fun `throws when setting flash without opening`() {
        mockCameraProvider.addCamera(CameraInfo("0", CameraFacing.BACK, hasFlash = true))

        assertThrows<CameraNotOpenException> {
            cameraStream.setFlash(true)
        }
    }

    // ==================== Configuration ====================

    @Test
    fun `configures capture resolution`() {
        mockCameraProvider.addCamera(CameraInfo("0", CameraFacing.BACK, hasFlash = true))
        cameraStream.open()

        cameraStream.setResolution(1280, 720)
        cameraStream.startCapture()
        mockCameraProvider.emitFrames(1)

        assertThat(mockCameraProvider.getConfiguredWidth()).isEqualTo(1280)
        assertThat(mockCameraProvider.getConfiguredHeight()).isEqualTo(720)
    }

    @Test
    fun `configures frame rate`() {
        mockCameraProvider.addCamera(CameraInfo("0", CameraFacing.BACK, hasFlash = true))
        cameraStream.open()

        cameraStream.setFrameRate(15)

        assertThat(mockCameraProvider.getConfiguredFrameRate()).isEqualTo(15)
    }

    @Test
    fun `uses default resolution of 720p`() {
        mockCameraProvider.addCamera(CameraInfo("0", CameraFacing.BACK, hasFlash = true))
        cameraStream.open()
        cameraStream.startCapture()

        assertThat(mockCameraProvider.getConfiguredWidth()).isEqualTo(1280)
        assertThat(mockCameraProvider.getConfiguredHeight()).isEqualTo(720)
    }

    @Test
    fun `uses default frame rate of 30fps`() {
        mockCameraProvider.addCamera(CameraInfo("0", CameraFacing.BACK, hasFlash = true))
        cameraStream.open()

        assertThat(mockCameraProvider.getConfiguredFrameRate()).isEqualTo(30)
    }
}
