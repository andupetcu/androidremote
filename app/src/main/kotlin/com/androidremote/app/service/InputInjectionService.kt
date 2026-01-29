package com.androidremote.app.service

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.util.Log
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent
import com.androidremote.feature.input.GestureSpec

/**
 * Accessibility service for injecting touch gestures.
 *
 * This service:
 * - Receives gesture commands from the remote controller
 * - Dispatches gestures via dispatchGesture()
 * - Supports tap, long press, swipe, and pinch gestures
 *
 * Requires user to enable in Settings > Accessibility
 */
class InputInjectionService : AccessibilityService() {

    companion object {
        private const val TAG = "InputInjectionService"

        @Volatile
        var instance: InputInjectionService? = null
            internal set
    }

    override fun onServiceConnected() {
        super.onServiceConnected()

        // Clear touch exploration flag — it can interfere with gesture injection
        val info = serviceInfo ?: AccessibilityServiceInfo()
        info.flags = info.flags and AccessibilityServiceInfo.FLAG_REQUEST_TOUCH_EXPLORATION_MODE.inv()
        serviceInfo = info

        Log.i(TAG, "onServiceConnected: capabilities=${serviceInfo?.capabilities}, flags=${serviceInfo?.flags}")
        instance = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // We don't need to process accessibility events
        // This service is only for gesture injection
    }

    override fun onInterrupt() {
        // Called when the system wants to interrupt feedback
    }

    override fun onDestroy() {
        super.onDestroy()
        instance = null
    }

    /**
     * Dispatches a gesture from a GestureSpec.
     *
     * @param spec The gesture specification to execute
     * @return true if the gesture was dispatched successfully
     */
    fun dispatchGesture(spec: GestureSpec): Boolean {
        val gestureBuilder = GestureDescription.Builder()

        for (stroke in spec.strokes) {
            val isSinglePoint = stroke.startX == stroke.endX && stroke.startY == stroke.endY
            val path = Path().apply {
                moveTo(stroke.startX.toFloat(), stroke.startY.toFloat())
                if (isSinglePoint) {
                    // Single-point gesture (tap/long-press): only moveTo, no lineTo.
                    // A zero-length lineTo can cause dispatchGesture to silently drop the gesture.
                } else if (stroke.path.size > 2) {
                    // Complex path with intermediate points
                    for (point in stroke.path.drop(1)) {
                        lineTo(point.x.toFloat(), point.y.toFloat())
                    }
                } else {
                    // Simple start to end
                    lineTo(stroke.endX.toFloat(), stroke.endY.toFloat())
                }
            }
            val strokeDescription = GestureDescription.StrokeDescription(
                path,
                0,
                spec.duration
            )
            gestureBuilder.addStroke(strokeDescription)
        }

        return try {
            val callback = object : GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription?) {
                    android.util.Log.d(TAG, "Gesture COMPLETED")
                }
                override fun onCancelled(gestureDescription: GestureDescription?) {
                    android.util.Log.w(TAG, "Gesture CANCELLED")
                }
            }
            dispatchGesture(gestureBuilder.build(), callback, null)
        } catch (e: Exception) {
            android.util.Log.e(TAG, "dispatchGesture threw: ${e.message}")
            false
        }
    }

    /**
     * Dispatches a key event via accessibility global actions.
     *
     * Note: AccessibilityService can only perform certain global actions,
     * not arbitrary key events. This maps common navigation keys to their
     * corresponding global actions.
     *
     * @param keyCode The Android key code to dispatch
     * @return true if the key event was dispatched successfully, false if unsupported
     */
    fun dispatchKeyEvent(keyCode: Int): Boolean {
        val globalAction = when (keyCode) {
            KeyEvent.KEYCODE_BACK -> GLOBAL_ACTION_BACK
            KeyEvent.KEYCODE_HOME -> GLOBAL_ACTION_HOME
            KeyEvent.KEYCODE_APP_SWITCH -> GLOBAL_ACTION_RECENTS
            KeyEvent.KEYCODE_NOTIFICATION -> GLOBAL_ACTION_NOTIFICATIONS
            KeyEvent.KEYCODE_POWER -> GLOBAL_ACTION_LOCK_SCREEN
            KeyEvent.KEYCODE_SEARCH -> GLOBAL_ACTION_QUICK_SETTINGS
            else -> return false // Unsupported key code
        }

        return try {
            performGlobalAction(globalAction)
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Dispatches a tap gesture at the specified coordinates.
     */
    fun dispatchTap(x: Int, y: Int): Boolean {
        android.util.Log.d(TAG, "dispatchTap($x, $y)")
        val path = Path().apply {
            moveTo(x.toFloat(), y.toFloat())
        }
        val strokeDescription = GestureDescription.StrokeDescription(
            path,
            0,
            100 // 100ms tap duration
        )
        val gesture = GestureDescription.Builder()
            .addStroke(strokeDescription)
            .build()

        return try {
            val callback = object : GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription?) {
                    android.util.Log.d(TAG, "dispatchTap COMPLETED at ($x, $y)")
                }
                override fun onCancelled(gestureDescription: GestureDescription?) {
                    android.util.Log.w(TAG, "dispatchTap CANCELLED at ($x, $y)")
                }
            }
            dispatchGesture(gesture, callback, null)
        } catch (e: Exception) {
            android.util.Log.e(TAG, "dispatchTap threw: ${e.message}")
            false
        }
    }

    /**
     * Dispatches a swipe gesture from start to end coordinates.
     */
    fun dispatchSwipe(startX: Int, startY: Int, endX: Int, endY: Int, durationMs: Long): Boolean {
        val path = Path().apply {
            moveTo(startX.toFloat(), startY.toFloat())
            lineTo(endX.toFloat(), endY.toFloat())
        }
        val strokeDescription = GestureDescription.StrokeDescription(
            path,
            0,
            durationMs
        )
        val gesture = GestureDescription.Builder()
            .addStroke(strokeDescription)
            .build()

        return try {
            dispatchGesture(gesture, null, null)
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Dispatches a long press gesture at the specified coordinates.
     */
    fun dispatchLongPress(x: Int, y: Int): Boolean {
        val path = Path().apply {
            moveTo(x.toFloat(), y.toFloat())
        }
        val strokeDescription = GestureDescription.StrokeDescription(
            path,
            0,
            600 // 600ms long press duration
        )
        val gesture = GestureDescription.Builder()
            .addStroke(strokeDescription)
            .build()

        return try {
            dispatchGesture(gesture, null, null)
        } catch (e: Exception) {
            false
        }
    }
}
