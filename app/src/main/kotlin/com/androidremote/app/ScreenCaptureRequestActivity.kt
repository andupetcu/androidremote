package com.androidremote.app

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * Transparent activity that requests MediaProjection permission.
 *
 * This activity is launched by RemoteSessionService when a remote session
 * connects and needs screen capture. It shows the system permission dialog
 * and forwards the result back to the service.
 */
class ScreenCaptureRequestActivity : Activity() {

    companion object {
        private const val TAG = "ScreenCaptureRequest"
        private const val REQUEST_MEDIA_PROJECTION = 1001
        private const val FINISH_DELAY_MS = 500L // Delay to allow MediaProjection to stabilize
        const val ACTION_SCREEN_CAPTURE_RESULT = "com.androidremote.app.SCREEN_CAPTURE_RESULT"
        const val EXTRA_RESULT_CODE = "result_code"
        const val EXTRA_RESULT_DATA = "result_data"

        fun createIntent(context: Context): Intent {
            return Intent(context, ScreenCaptureRequestActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        }
    }

    private val handler = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Request MediaProjection permission
        val projectionManager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val captureIntent = projectionManager.createScreenCaptureIntent()
        @Suppress("DEPRECATION")
        startActivityForResult(captureIntent, REQUEST_MEDIA_PROJECTION)
    }

    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)

        if (requestCode == REQUEST_MEDIA_PROJECTION) {
            Log.d(TAG, "MediaProjection result: $resultCode")

            if (resultCode == RESULT_OK && data != null) {
                // Send result to RemoteSessionService via broadcast
                val broadcast = Intent(ACTION_SCREEN_CAPTURE_RESULT).apply {
                    setPackage(packageName)
                    putExtra(EXTRA_RESULT_CODE, resultCode)
                    putExtra(EXTRA_RESULT_DATA, data)
                }
                sendBroadcast(broadcast)
                Log.i(TAG, "Screen capture permission granted")
            } else {
                Log.w(TAG, "Screen capture permission denied")
            }

            // Delay finish to allow MediaProjection to be processed by the service
            // This prevents EGL/surface issues when the activity window is destroyed
            handler.postDelayed({
                finish()
            }, FINISH_DELAY_MS)
        }
    }
}
