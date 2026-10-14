# T7: Web remote-desktop client (starts after T5)
Model: Sonnet. Findings: WU-05, WU-06, WU-07, WU-08, WU-09, WU-10 (UI side), WU-11, plus contracts C8 and C9 on the browser side.
Owned: web-ui/src/components/RemoteScreen.tsx, components/RelayRemoteScreen.tsx, hooks/useWebRTC.ts, lib/FrameDecoder.ts, and their tests (unskip the WU-05 KNOWN-BUG test).

Do:
1. C9: create the `commands` (reliable) and `video` (`ordered:false, maxRetransmits:0`) channels. Demultiplex messages in one place; don't overwrite the onmessage handler (the review found that RemoteScreen replaces the hook's handler). Send REQUEST_KEYFRAME after a decode error or a gap in chunk or frame sequence. Handle SCREEN_INFO for size and rotation.
2. WU-05, WU-06: map pointer coordinates against the drawn video content box (account for letterboxing and object-fit) and the current SCREEN_INFO rotation. Use pointer capture so release outside the canvas works; no spurious long-press.
3. WU-07, WU-08: show decode errors and stalls in the UI ("video stalled, requesting keyframe…"). Bound queues: drop non-keyframes until the next keyframe, cap the chunk-assembly map by bytes and count, and keep latency bounded by skipping to the latest keyframe when the backlog grows.
4. WU-09: fix the stale `ws.onclose` closure, replace the fixed 6 s sleep with real signaling events plus a timeout, and report connect failures.
5. WU-10: get ICE servers from `GET /api/ice-servers` and remove the hard-coded TURN credentials from source.
6. C8: show CAPTURE_FAILED with its reason.
7. WU-11 (relay desktop, Rust agent): draw tiles in order (sequence or await), coalesce mouse moves to animation frames, reconnect with a fresh ticket, and release pressed keys on blur.
Tests first: letterbox mapping (unskip), rotation mapping, pointer capture, decoder backlog bound, keyframe request on error, error surfaced, ICE from endpoint, CAPTURE_FAILED shown, relay tile ordering.
