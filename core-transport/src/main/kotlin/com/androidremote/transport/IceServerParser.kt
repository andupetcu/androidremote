package com.androidremote.transport

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * Parses the `iceServers` array of a START_REMOTE payload / `GET /api/ice-servers` response
 * (contract C7) into a [PeerConnectionConfig].
 */
object IceServerParser {

    /** Falls back to [RemoteSession.DEFAULT_CONFIG] (STUN only) when nothing usable is given. */
    fun parseConfig(element: JsonElement?): PeerConnectionConfig {
        val servers = parse(element)
        return if (servers.isEmpty()) RemoteSession.DEFAULT_CONFIG else PeerConnectionConfig(servers)
    }

    fun parseConfigFromString(text: String?): PeerConnectionConfig {
        if (text.isNullOrBlank()) return RemoteSession.DEFAULT_CONFIG
        return try {
            val element = Json.parseToJsonElement(text)
            // Accept both a bare array and the `{ "iceServers": [...] }` response object.
            val array = (element as? JsonObject)?.get("iceServers") ?: element
            parseConfig(array)
        } catch (e: Exception) {
            RemoteSession.DEFAULT_CONFIG
        }
    }

    fun parse(element: JsonElement?): List<IceServer> {
        val array = element as? JsonArray ?: return emptyList()
        return array.mapNotNull { entry ->
            val obj = entry as? JsonObject ?: return@mapNotNull null
            val urls = when (val u = obj["urls"] ?: obj["url"]) {
                is JsonPrimitive -> listOfNotNull(u.contentOrNull)
                is JsonArray -> u.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
                else -> emptyList()
            }.filter { it.isNotBlank() }
            if (urls.isEmpty()) return@mapNotNull null
            IceServer(
                urls = urls,
                username = (obj["username"] as? JsonPrimitive)?.contentOrNull,
                credential = (obj["credential"] as? JsonPrimitive)?.contentOrNull
            )
        }
    }
}
