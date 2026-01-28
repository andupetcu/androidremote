package com.androidremote.app.service

import android.app.Service
import android.content.Intent
import android.os.IBinder

/**
 * Foreground service that manages screen capture via MediaProjection.
 *
 * This service:
 * - Holds the MediaProjection token
 * - Creates VirtualDisplay for screen capture
 * - Feeds frames to the encoder and WebRTC track
 * - Shows persistent notification while active
 *
 * Requires foregroundServiceType="mediaProjection" (Android 14+)
 */
class ScreenCaptureService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        // TODO: Initialize screen capture components
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // TODO: Start foreground notification and begin capture
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        // TODO: Release MediaProjection and cleanup
    }
}
