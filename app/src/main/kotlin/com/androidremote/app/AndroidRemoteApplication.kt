package com.androidremote.app

import android.app.Application
import org.webrtc.PeerConnectionFactory

/**
 * Application class that handles one-time initialization.
 *
 * WebRTC's PeerConnectionFactory.initialize() MUST only be called once
 * per application lifecycle. Calling it multiple times can corrupt
 * internal native state and cause SIGSEGV crashes.
 */
class AndroidRemoteApplication : Application() {

    override fun onCreate() {
        super.onCreate()
        initializeWebRtc()
    }

    private fun initializeWebRtc() {
        val initOptions = PeerConnectionFactory.InitializationOptions.builder(this)
            .setEnableInternalTracer(false)
            .createInitializationOptions()
        PeerConnectionFactory.initialize(initOptions)
    }
}
