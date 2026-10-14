package com.androidremote.app.api

import io.ktor.client.HttpClient
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.api.createClientPlugin
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.header
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json
import java.net.URI

/** Config for [DeviceTokenPlugin]. */
class DeviceTokenConfig {
    /** Only requests to this host get the token. Null means every host. */
    var host: String? = null
    var tokenProvider: () -> String? = { null }
}

/**
 * Adds `X-Session-Token` (contract C1) to outgoing requests. The token is read for each request,
 * and it is only sent to the configured server host, so APK downloads from a third-party host
 * never receive it.
 */
val DeviceTokenPlugin = createClientPlugin("DeviceToken", ::DeviceTokenConfig) {
    val host = pluginConfig.host
    val provider = pluginConfig.tokenProvider
    onRequest { request, _ ->
        if (host == null || request.url.host.equals(host, ignoreCase = true)) {
            provider()?.takeIf { it.isNotBlank() }?.let { request.header(DeviceHttpClient.SESSION_TOKEN_HEADER, it) }
        }
    }
}

/**
 * The single factory for HTTP clients that talk to the device-facing server API.
 * CommandApiClient, TelemetryCollector and the APK downloader all use it.
 */
object DeviceHttpClient {
    const val SESSION_TOKEN_HEADER = "X-Session-Token"

    fun create(
        baseUrl: String,
        tokenProvider: () -> String?,
        engine: HttpClientEngine = OkHttp.create()
    ): HttpClient {
        val serverHost = runCatching { URI(baseUrl).host }.getOrNull()
        return HttpClient(engine) {
            install(ContentNegotiation) {
                json(Json { ignoreUnknownKeys = true; isLenient = true })
            }
            install(HttpTimeout) {
                connectTimeoutMillis = 15_000
                socketTimeoutMillis = 60_000
                requestTimeoutMillis = 60_000
            }
            install(DeviceTokenPlugin) {
                host = serverHost
                this.tokenProvider = tokenProvider
            }
        }
    }
}
