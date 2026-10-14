package com.androidremote.app.mdm

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class StartRemotePayloadTest {

    @Test
    fun `iceServers from START_REMOTE payload are forwarded as JSON`() {
        val payload = Json.parseToJsonElement(
            """{"signalingUrl":"https://mdm.example/ws","iceServers":[{"urls":["turn:t.example:3478"],"username":"1:dev","credential":"abc"}]}"""
        ).jsonObject

        val extra = StartRemotePayload.iceServersExtra(payload)

        val parsed = Json.parseToJsonElement(extra!!) as JsonArray
        assertEquals(1, parsed.size)
        assertEquals("1:dev", parsed[0].jsonObject["username"].toString().trim('"'))
    }

    @Test
    fun `missing iceServers gives no extra`() {
        val payload = Json.parseToJsonElement("""{"signalingUrl":"https://mdm.example/ws"}""").jsonObject
        assertNull(StartRemotePayload.iceServersExtra(payload))
    }
}
