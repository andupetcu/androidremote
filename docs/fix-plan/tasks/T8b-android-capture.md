# T8b: Android capture pipeline (starts after T4)
Model: Sonnet. Findings: AR-07, AR-11, AR-14, AR-12 (encoder side), AR-19, and C8 on the device side.
Owned: screen-server/**, app/.../service/{ScreenServerManager,ScreenServerClient,ScreenCaptureService}.kt, feature-screen/**, app/.../ScreenCaptureRequestActivity.kt, plus tests.

Do:
1. AR-07: when capture can't start (no su, screen-server unreachable after retries, SurfaceControl failure), call `captureFailed(reason)`; T8a sends CAPTURE_FAILED. Retry with backoff while the session is alive. On rooted devices, pre-start the screen-server at boot and after app update so the first session doesn't pay about 4 s. The MediaProjection fallback for non-root devices: wire the existing ScreenCaptureRequestActivity path so a non-root device can do remote desktop after a human taps "Start now". Report `reason:"consent_required"` until granted. Remove the TODO stub if replaced.
2. AR-14: detect rotation and display-size changes in the screen-server, reconfigure the encoder, and emit screen info (width, height, rotation) to the client, which calls `onScreenInfo`.
3. Keyframe on demand: support a control message from the client to the screen-server to request a sync frame (`PARAMETER_KEY_REQUEST_SYNC_FRAME`), exposed as `requestKeyFrame()`.
4. AR-11: frames above 1 MiB must not end the stream. Raise the limit to a sane cap (for example 8 MiB), log, and skip oversized frames without tearing down.
5. AR-19: fix the accumulating shutdown hook. Delete the unused crypto code only if nothing references it (check core-crypto usage); otherwise leave it.
Tests first where testable on the JVM: the frame reader with oversized and malformed frames, rotation-change handling (extract the logic), the keyframe-request protocol encoding, the retry/backoff policy, the captureFailed path.
