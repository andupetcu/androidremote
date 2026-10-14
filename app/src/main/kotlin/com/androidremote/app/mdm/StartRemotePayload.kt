package com.androidremote.app.mdm

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/** Reads the parts of a START_REMOTE payload that are handed to RemoteSessionService (contract C7). */
object StartRemotePayload {
    /** The `iceServers` array as JSON text for `RemoteSessionService.EXTRA_ICE_SERVERS`, or null when absent. */
    fun iceServersExtra(payload: JsonObject): String? = (payload["iceServers"] as? JsonArray)?.toString()
}
