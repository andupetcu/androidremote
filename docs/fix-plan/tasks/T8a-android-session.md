# T8a: Android remote session lifecycle, channels and input (starts after T4)
Model: Sonnet. Findings: AR-03, AR-04, AR-05, AR-06, AR-09, AR-15, AR-10, AR-13 (device side), AR-12 (device side of C9), AR-01 (device side: execute MDM commands only from the authenticated controller session).
Owned: app/.../service/RemoteSessionService.kt, app/.../controller/{SessionController,SessionState,MdmHandler,CommandResult}.kt, app/.../webrtc/**, core-transport/**, core-protocol/**, app/.../service/{InputInjectionService,InputInjectionAccessibilityProvider}.kt, plus tests.
Read only: ScreenServerManager/ScreenServerClient (T8b changes them in parallel; use only their public API, and agree via the contract: T8b exposes `requestKeyFrame()`, a screen-info callback `onScreenInfo(width,height,rotation)` and a `captureFailed(reason)` callback).

Do:
1. AR-03: when the viewer leaves (peer-left, channel closed, ICE failed past a grace period), stop capture and encoding and end the session after a configurable idle timeout (default 30 s). Add a max session duration (default 4 h).
2. AR-04: treat ICE `disconnected` as transient, with a 10 s grace before `failed`. After a reconnect or a new peer, restart video and send SCREEN_INFO and a keyframe. AR-15: a re-sent START_REMOTE while connected restarts video cleanly.
3. AR-05, AR-09: replace `MutableSharedFlow(replay=1)` plus `tryEmit` with `Channel(capacity = BUFFERED)` or a SharedFlow with `extraBufferCapacity` and suspending emit. Collectors catch per-message exceptions and keep running.
4. AR-06: run input on a dedicated single-thread dispatcher, never Main or runBlocking. Keep a persistent root shell (one `su` process with stdin) for `input` commands, with per-command timeouts.
5. C9: send video on the `video` channel when it is open; on REQUEST_KEYFRAME call T8b's `requestKeyFrame()`; forward SCREEN_INFO and CAPTURE_FAILED.
6. AR-10: boot auto-start must derive the ws(s) signaling URL from the server base URL (http→ws, https→wss, plus `/ws`), and must not leave a stuck "screen is being shared" service on failure.
7. AR-13: use `iceServers` from the START_REMOTE payload (C7).
8. Device auth on /ws (C4): the device sends `Authorization: Bearer <session token>` on the WebSocket upgrade.
Tests first: idle timeout stops capture; ICE grace; video restarts after reconnect; no dropped commands under burst (100 rapid inputs all processed in order); a collector survives a bad message; the input dispatcher isn't Main; the URL derivation; ICE from the payload; the auth header on the upgrade.
