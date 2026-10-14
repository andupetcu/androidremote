# T3: Android device auth, command loop and verified installs
Model: Sonnet. Findings: AM-01 (client side), AM-04, AM-03, AM-12, AM-11, AM-20, AM-05 (device side), AM-13, AM-21.
Owned: app/src/main/kotlin/com/androidremote/app/api/**, app/.../mdm/CommandPollingService.kt, app/.../mdm/TelemetryCollector.kt, app/.../mdm/SilentPackageInstaller.kt, app/.../mdm/InstallResultReceiver.kt, app/build.gradle.kts (only to add the BuildConfig field ALLOW_UNVERIFIED_APK=false and test deps), and app/src/test/** files you add.
Read only: ui/SessionStorage.kt (`getSessionToken()`).

Do:
1. C1: every call to `/api/devices/...` (pending poll, ack, telemetry, app inventory, app-updates, policy, events) sends `X-Session-Token`. Centralise it in one Ktor `defaultRequest`/plugin in the API client factory, and use the same client in TelemetryCollector and CommandPollingService instead of ad-hoc clients.
2. C5, device side: keep a persistent ring of the last 200 executed command IDs (SharedPreferences or a small file). On receiving a duplicate, ack its stored result and don't execute it again. Ack `executing` before running and `completed`/`failed` after, and check each ack's result: retry with backoff, and queue failed acks to resend on the next poll.
3. Per-command timeouts (install 10 min, others 2 min), via `withTimeout`. Run installs and uninstalls in a separate coroutine so REBOOT/LOCK are never blocked behind a stuck install. A `STATUS_PENDING_USER_ACTION` result becomes a failed result with a clear message (AM-03, AM-21).
4. Backoff on errors (AM-12): exponential from the poll interval up to 5 minutes, with jitter. A 401 or 404 means the enrollment is invalid: stop polling and surface the state.
5. AM-11: request the battery-optimisation exemption for real when the app is Device Owner, and add a WorkManager periodic backstop (15 min) that restarts the polling service if it is dead.
6. C6: SilentPackageInstaller verifies SHA-256 of the downloaded file against the payload `sha256` before opening the PackageInstaller session. Refuse when it is missing unless `BuildConfig.ALLOW_UNVERIFIED_APK`. Refuse `http://` URLs whose host isn't the configured server host. Make the download resumable (Range) with a length check and a timeout (AM-13).
7. AM-20: build the app inventory JSON with kotlinx.serialization, not string concatenation.
Tests first (JVM unit tests with Robolectric/MockK and Ktor MockEngine where needed): the header is present on every call; a duplicate command isn't re-executed; a failed ack is retried and queued; a timeout produces failed; backoff grows and caps; a sha256 mismatch refuses the install; missing sha256 is refused; inventory JSON escaping round-trips with backslashes and quotes.
