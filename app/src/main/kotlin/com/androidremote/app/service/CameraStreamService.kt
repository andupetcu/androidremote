package com.androidremote.app.service

import android.app.Service
import android.content.Intent
import android.os.IBinder

/**
 * Foreground service that manages camera streaming.
 *
 * This service:
 * - Opens camera via Camera2/CameraX
 * - Captures frames and feeds to encoder
 * - Streams as WebRTC video track
 * - Shows persistent notification while active
 *
 * Requires foregroundServiceType="camera" (Android 14+)
 */
class CameraStreamService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        // TODO: Initialize camera components
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // TODO: Start foreground notification and begin camera capture
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        // TODO: Release camera and cleanup
    }
}
