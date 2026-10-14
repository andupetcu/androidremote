# T8b: Android capture pipeline

Findings: AR-07, AR-11, AR-14, AR-12 (encoder side: keyframe on demand), AR-19, C8 device side, plus the BLOCKING T4 follow-up.

## BLOCKING T4 follow-up: done
`ScreenServerManager` now builds the `app_process` line with `ScreenServerCommand.build(...)`, which appends `-u ${android.os.Process.myUid()}` (both `startViaRoot` and `startViaShell`). New `ScreenServerManager.adbStartHint()` returns the same command for humans.
For T8a: the hint strings in `RemoteSessionService.kt` (~462, ~509) still lack `-u`. Replace them with `screenServerManager.adbStartHint()` (or `ScreenServerCommand.adbHint(...)`). Not edited by me (T8a owns that file).

## Tests added (all written first)
- screen-server `ScreenProtocolTest` (6): packet encoding, SCREEN_INFO packet, control byte, rotation mapping, display-change detector, single shutdown hook.
- app `FrameReaderTest` (9): normal frame, 2 MiB frame, oversized frame skipped and stream continues, zero/negative size, absurd size, truncated payload, SCREEN_INFO parse and malformed, keyframe control encoding.
- app `CaptureRetryPolicyTest` (2), `ScreenServerCommandTest` (3: `-u` present, optional log, hint), `ScreenCaptureControllerTest` (5: consent_required, unreachable reported once + backoff + stop, recovery with screen info/frames/keyframe request, early death -> capture_setup_failed + server restart, no-op keyframe request).

## RED (classes did not exist: compile failure)
```
> Task :screen-server:compileDebugUnitTestKotlin FAILED
e: ScreenProtocolTest.kt:3:39 Unresolved reference 'protocol'.
e: ScreenProtocolTest.kt:18:21 Unresolved reference 'ScreenProtocol'.
e: ScreenProtocolTest.kt:57:21 Unresolved reference 'DisplayChangeDetector'.
> Task :app:compileDebugUnitTestKotlin FAILED   (FrameReader, CaptureRetryPolicy, ScreenServerCommand, ScreenCaptureController unresolved)
```
Old behaviour pinned: `ScreenServerClient` used `ByteArray(1024*1024)` and `break`ed on a bigger frame leaving `_isConnected=true` (AR-11); no rotation polling or SCREEN_INFO in `SurfaceEncoder` (AR-14); `Server.runCapture` added a shutdown hook per client (AR-19); `app_process` line had no `-u`.

## GREEN
```
./gradlew :screen-server:testDebugUnitTest --rerun-tasks   BUILD SUCCESSFUL   screen-server 11 tests, 0 failures (was 5)
./gradlew :app:testDebugUnitTest                           app 225 tests; my 19 new tests pass; 1 failure is AppManagementTest (another agent's in-progress work, not T8b)
./gradlew :app:compileDebugKotlin                          BUILD SUCCESSFUL
```
App count before my work: 156 at the end of T4.

## What changed, per finding
- AR-11: new `FrameReader`. Per-frame allocation, 8 MiB cap: bigger frames are consumed, logged and reported as `Skipped` (client then calls `requestKeyFrame()`), the stream continues. Size <= 0 or > 64 MiB, or a bad SCREEN_INFO, throws `FrameProtocolException` (an IOException) so the client ends the stream and the owner reconnects. `firstFrameReceived` is now reset per connect.
- AR-14: `SurfaceEncoder` polls the display every 500 ms (`ScreenCapture.currentState()`, quiet `DisplayInfo.getDisplayInfo(verbose=false)`). On a size or rotation change the encode loop returns, the outer loop re-prepares the capture, reconfigures the codec (new SPS/IDR follow) and writes a SCREEN_INFO packet. SCREEN_INFO is also written right after the header at start. `ScreenServerClient` parses it, updates `videoWidth/Height` and calls `onScreenInfo(w,h,rotation)`.
- Keyframe on demand (C9): app -> server control byte 0x01. `Server` reads the socket, calls `SurfaceEncoder.requestKeyFrame()` (`MediaCodec.setParameters(PARAMETER_KEY_REQUEST_SYNC_FRAME)`). When the client leaves, the control reader stops the encoder so the next client can connect. Client side: `ScreenServerClient.requestKeyFrame()`.
- AR-07: new `ScreenCaptureController` supervises capture while the session lives: starts the server if not running (root), connects, and retries with capped exponential backoff (1 s, 2 s, ... 30 s) forever; a server restart is forced after an early death and every 3rd failed connect. Each distinct failure is reported once via `onCaptureFailed(reason)` and re-armed once frames flow: `screen_server_unreachable`, `capture_setup_failed` (died before first frame), `screen_server_died`, `consent_required` (no root and no running server). An adb-started server is picked up by the same loop. The existing server is reused now (no forced restart per session) so a pre-started server saves the ~4 s; a stuck server exits on its own via the 5 s first-frame timeout and the client-gone stop.
  - Pre-start: `ScreenServerManager.prestart(restart)`.
  - Non-root fallback: `ScreenCaptureService` (was a TODO stub) now posts a high-priority "Start now" notification (plus a direct launch attempt) that opens `ScreenCaptureRequestActivity`; the activity now also broadcasts a denied result.
- AR-12 (encoder side only): keyframe request exists. Flow control / `bufferedAmount` / unordered video channel are T8a/web.
- AR-19: one shutdown hook (`StopHook`) for the whole server process, stopping only the current encoder. Crypto code NOT deleted: `RootDaemonInjector` still references `RootDaemonBridge`/`CommandSigner`.

## Interface for T8a
Use `ScreenCaptureController` (package `com.androidremote.app.service`) instead of the inline code in `startScreenServerCapture()`:
```kotlin
val controller = ScreenCaptureController(serviceScope, ScreenServerBackend(ScreenServerManager(this)))
controller.onScreenInfo = { w, h, rotation -> /* send {"type":"SCREEN_INFO","width":w,"height":h,"rotation":rotation}, update CoordinateMapper/InputHandler.updateScreenConfig */ }
controller.onCaptureFailed = { reason -> /* send {"type":"CAPTURE_FAILED","reason":reason} (C8) */ }
serviceScope.launch { controller.frames.collect { _frameDataFlow.emit(it) } }   // frames incl. config + keyframes
controller.start()
// on REQUEST_KEYFRAME from the browser (commands channel):
controller.requestKeyFrame()
// on session end or when MediaProjection capture takes over:
controller.stop()
```
- `onScreenInfo(width,height,rotation)`: rotation is 0, 90, 180, 270. Fired at start and on every rotation or resolution change (width/height are the encoded video size). Resend to a viewer that joins later by caching the last value.
- `onCaptureFailed(reason)`: reasons above; delivered once per distinct failure, re-armed when frames flow. Called from a coroutine thread, not Main.
- `requestKeyFrame()`: non-blocking, no-op if not connected; the keyframe arrives within about 1 s.
- `consent_required` flow: on this reason, call `startService(ScreenCaptureService.promptIntent(this))`. The existing `ScreenCaptureRequestActivity` broadcast (`ACTION_SCREEN_CAPTURE_RESULT`, now also sent on denial with `EXTRA_RESULT_CODE != RESULT_OK` and no data) leads to your existing `startScreenCapture(resultCode, data)`; call `controller.stop()` then and `ScreenCaptureService.cancelIntent(this)`. On denial report `CAPTURE_FAILED("consent_denied")`. `ScreenCaptureManager`/`H264Encoder` (MediaProjection path) already have `H264Encoder.requestKeyFrame()` for the REQUEST_KEYFRAME path.
- Hint strings: use `ScreenServerManager.adbStartHint()` (includes `-u`).
- `ScreenServerClient` (if still used directly): new `onEnded` (set it to disable its own reconnect), `onScreenInfo`, `requestKeyFrame()`; `onEarlyDeath` kept.

## Needs from other owners
1. T8a: the interface above, the `-u` hint strings, and `AndroidManifest` is unchanged (service/activity already declared; `POST_NOTIFICATIONS` is already requested).
2. Boot / update receivers (not mine): call `ScreenServerManager(context).prestart(restart = false)` on BOOT_COMPLETED and `prestart(restart = true)` on MY_PACKAGE_REPLACED, off the main thread (it does `su` work). Not wired because those receivers are not in T8b's files.
3. `AndroidBackedTest.kt`/`AppManagementTest` (another agent) was failing to compile or failing during my run; unrelated.

## Could not fix / test
- Rotation detection against a real display, `PARAMETER_KEY_REQUEST_SYNC_FRAME` on a real encoder, `su` start, the consent notification, and the control-reader thread in `Server`: need a device. Their decision logic (protocol, change detector, retry policy, supervisor, reader) is unit-tested.
- The 180-degree inverted mapping in `CoordinateMapper` (AR-14 note) is not mine (input module); needs hardware.
