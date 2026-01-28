package com.androidremote.feature.input

import android.content.Context
import android.util.Log

/**
 * Factory for creating the best available [InputInjector] implementation.
 *
 * Selection priority:
 * 1. Root Daemon (if available) - fastest, <10ms per action
 * 2. ADB Shell (if available) - works on rooted/adb devices, ~100-200ms per action
 * 3. null - no suitable injector found
 *
 * ## Usage
 *
 * ```kotlin
 * val injector = InputInjectorFactory.create(context)
 * if (injector != null) {
 *     Log.d("Input", "Using ${injector.getName()}")
 *     injector.tap(500, 800)
 * } else {
 *     Log.w("Input", "No input injection available")
 * }
 * ```
 *
 * ## Future Extensions
 *
 * The factory can be extended to support additional implementations:
 * - AccessibilityService injector (user must enable, limited gestures)
 * - Instrumentation injector (for testing scenarios)
 */
object InputInjectorFactory {

    private const val TAG = "InputInjectorFactory"

    /**
     * Create the best available input injector.
     *
     * @param context Android context (may be needed for some implementations)
     * @param preferredType Optional preferred implementation type
     * @return The best available injector, or null if none available
     */
    fun create(
        context: Context? = null,
        preferredType: InjectorType? = null
    ): InputInjector? {

        // If a specific type is requested, try only that
        if (preferredType != null) {
            return createSpecific(preferredType, context)
        }

        // Try implementations in order of preference
        val candidates = listOf(
            InjectorType.ROOT_DAEMON,
            InjectorType.ADB_SHELL
        )

        for (type in candidates) {
            val injector = createSpecific(type, context)
            if (injector != null && injector.isAvailable()) {
                Log.i(TAG, "Selected input injector: ${injector.getName()}")
                return injector
            }
        }

        Log.w(TAG, "No input injector available")
        return null
    }

    /**
     * Create a specific type of injector.
     *
     * @param type The type of injector to create
     * @param context Android context (may be needed for some implementations)
     * @return The injector instance, or null if not supported
     */
    private fun createSpecific(type: InjectorType, context: Context?): InputInjector? {
        return when (type) {
            InjectorType.ADB_SHELL -> AdbShellInjector()
            InjectorType.ROOT_DAEMON -> {
                // Root daemon requires a session key and socket connection
                // This is a placeholder - actual implementation would need
                // the session key from pairing
                Log.d(TAG, "Root daemon injector requires additional setup")
                null
            }
        }
    }

    /**
     * Get all available injector types.
     *
     * @return List of injector types that are currently available
     */
    fun getAvailableTypes(): List<InjectorType> {
        return InjectorType.entries.filter { type ->
            createSpecific(type, null)?.isAvailable() == true
        }
    }
}

/**
 * Types of input injector implementations.
 */
enum class InjectorType {
    /** ADB shell commands via Runtime.exec() */
    ADB_SHELL,

    /** Root daemon via Unix socket */
    ROOT_DAEMON
}
