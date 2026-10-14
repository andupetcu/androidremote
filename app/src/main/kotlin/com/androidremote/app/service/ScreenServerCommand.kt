package com.androidremote.app.service

/**
 * Builds the shell line that starts the screen-server. The server rejects every client
 * unless it was started with `-u <uid of this app>` (AR-08), so the uid is mandatory here.
 */
object ScreenServerCommand {
    fun build(apkPath: String, serverClass: String, appUid: Int, logFile: String?): String {
        val log = if (logFile != null) " 2>$logFile" else ""
        return "CLASSPATH=$apkPath app_process / $serverClass -u $appUid$log &"
    }

    /** Command to show a human who has to start the server over adb. */
    fun adbHint(apkPath: String, serverClass: String, appUid: Int): String =
        "adb shell CLASSPATH=$apkPath app_process / $serverClass -u $appUid"
}
