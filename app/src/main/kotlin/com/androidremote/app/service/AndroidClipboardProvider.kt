package com.androidremote.app.service

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import com.androidremote.feature.input.ClipboardProvider

/**
 * Android implementation of ClipboardProvider using ClipboardManager.
 *
 * Provides access to the system clipboard for reading and writing text content.
 */
class AndroidClipboardProvider(context: Context) : ClipboardProvider {

    private val clipboardManager: ClipboardManager =
        context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

    override fun getText(): String? {
        return try {
            val clipData = clipboardManager.primaryClip
            if (clipData != null && clipData.itemCount > 0) {
                clipData.getItemAt(0).text?.toString()
            } else {
                null
            }
        } catch (e: Exception) {
            // Clipboard access can fail in certain security contexts
            null
        }
    }

    override fun setText(text: String) {
        try {
            val clip = ClipData.newPlainText("Remote Input", text)
            clipboardManager.setPrimaryClip(clip)
        } catch (e: Exception) {
            // Clipboard access can fail in certain security contexts
        }
    }
}
