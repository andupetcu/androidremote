# Review fix programme: shared brief for implementing agents

Branch: `fix/review-2026-10-14`, LOCAL ONLY. Never push, never create remotes or PRs, never touch `master`.
Review report: https://claude.ai/artifact/X8T8wTqqgLhWwU974EgrUf
Finding text with file:line evidence: `docs/fix-plan/findings.json`. Look up your IDs there first; line numbers refer to commit bd2b525.

## Non-negotiable workflow: test-first, with proof
For every behaviour change:
1. Write the failing test(s) first. Run them and save the RED output (trimmed to the relevant lines) into your evidence file.
2. Implement the fix.
3. Run the same tests, plus the component's full suite, and save the GREEN output.
4. Evidence file: `docs/fix-plan/evidence/<TASK-ID>.md`, listing finding IDs, tests added, RED excerpt, GREEN excerpt, full-suite counts before and after, and anything you could NOT fix or test (say why).
If something genuinely cannot be unit-tested (for example an Android framework call that needs a real device), say so in the evidence file and add the closest testable seam: extract the logic into a pure function or class and test that.

## How to run tests
- Server: `cd server && npx jest` (or `npx jest test/<file>`).
- Web UI: `cd web-ui && npx vitest run` (or a single file).
- Android: `export JAVA_HOME=/opt/homebrew/opt/openjdk@17 ANDROID_HOME=$HOME/Library/Android/sdk`, then `./gradlew :app:testDebugUnitTest` or `:<module>:test` / `:<module>:testDebugUnitTest`. Compile check: `./gradlew :app:compileDebugKotlin`. Run Gradle commands one at a time; another agent may hold the Gradle daemon lock. If you hit a lock, wait and retry.

## File ownership
Edit ONLY the files your task lists as owned. You may READ anything. If you need a change in a file you don't own, stop. Describe the change in your evidence file under "Needs from other owners", and implement against the agreed contract below.
Other agents work in the same checkout at the same time. Their files may change under you; never revert or reformat them.

## Commits
- Commit only your own files: `git add <explicit paths>` then `git commit -m "<task-id>: <summary>"`. Never `git add -A` or `.`. Never amend or rebase.
- If `.git/index.lock` exists, wait a few seconds and retry; another agent is committing.
- NEVER run `git stash`, `git checkout -- <file>`, `git reset`, `git restore` or `git clean`: other agents have uncommitted work in this tree. To compare with an older version, use `git show <rev>:<path>` or `git diff`.
- No AI attribution or Co-Authored-By trailers (owner's rule).
- Commit when your tests are green. Several commits per task are fine.

## Cross-component contracts (all agents implement against these)
C1. Device REST auth. Every Android call to `/api/devices/:id/...` sends the header `X-Session-Token: <session token>` (from `SessionStorage.getSessionToken()`). The server REQUIRES it on all device-facing routes: heartbeat, `GET commands/pending`, `PATCH commands/:cmdId` (the ack), telemetry, apps, events, app-updates, policy, and file-transfer callbacks. The token must belong to the device in the URL and must not be expired. Temporary migration switch: env `ALLOW_TOKENLESS_DEVICES=true` lets token-less calls through with a warning log. It defaults to false. A device whose token is invalid gets 401.
C2. Device identity: the device ID always comes from the URL path. Fields in the body never override it.
C3. Browser WebSocket auth uses short-lived tickets. `POST /api/ws-ticket` (admin JWT required), with body `{ "purpose": "signaling" | "admin" | "relay", "deviceId"?: string }`, returns `{ "ticket": string, "expiresAt": number }`. The ticket is 32 random bytes, hex, single use, valid 60 s. The browser connects to `/ws?ticket=…` (controller) or `/admin?ticket=…`. The server validates and consumes the ticket during the HTTP upgrade and rejects the upgrade with 401 otherwise. No JWTs go in URLs.
C4. Device WebSocket auth on `/ws`. The device sends `Authorization: Bearer <session token>` on the upgrade request. The server validates it against the deviceId in the join message. Role comes from the credential (ticket means controller, device token means device) and is never taken from the message. A controller ticket may be bound to a deviceId; if so, joining another room is rejected. An unauthenticated socket can never evict an authenticated peer.
C5. Command lifecycle. States: pending → delivered (with `lease_expires_at`) → executing → completed | failed | expired. A poll returns pending commands plus delivered commands whose lease has expired; this is redelivery. The lease is 5 minutes by default. The device acks executing, then completed or failed. Commands have `expires_at`, set by type: REBOOT, LOCK, WIPE and START_REMOTE expire after 15 minutes by default, others after 7 days. Expired commands are never delivered and get status `expired`. The device keeps the last 200 executed command IDs and acks a duplicate without running it again. The heartbeat must NOT read or consume pending commands.
C6. APK integrity. At upload the server validates the package name (`^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$`), streams the file to disk, and computes `sha256`, stored with the package. INSTALL_APK command payloads include `sha256` (hex). The device refuses to install when the downloaded file's SHA-256 differs; when the payload has no sha256, it fails with "missing sha256" unless the app was built with BuildConfig flag `ALLOW_UNVERIFIED_APK`, which defaults to false.
C7. ICE servers. `GET /api/ice-servers` (admin JWT, or device token for a device) returns `{ iceServers: RTCIceServer[] }`, built from env `STUN_URLS` and `TURN_URLS` plus `TURN_SECRET`, with coturn REST-style time-limited credentials (username `<expiry>:<id>`, HMAC-SHA1). START_REMOTE payloads also carry `iceServers`. No TURN credentials in source.
C8. Capture failure. When the device can't start capture, it sends a data-channel JSON message `{"type":"CAPTURE_FAILED","reason":"..."}`. The web UI shows that reason instead of a black screen.
C9. Remote-desktop data channels. The browser, which is the offerer, creates two channels:
- `commands`: reliable and ordered. Carries input, MDM and ack JSON, plus control messages.
- `video`: `ordered:false, maxRetransmits:0`. Carries H.264 frames in the existing chunk format.
The device sends video on `video` when that channel is open, and otherwise falls back to `commands` for older browsers. On `commands`, the browser can send `{"type":"REQUEST_KEYFRAME"}` after a decode error or a gap. The device then asks the encoder for a sync frame (MediaCodec `PARAMETER_KEY_REQUEST_SYNC_FRAME`) and answers with a keyframe within about 1 s. The device sends `{"type":"SCREEN_INFO","width":w,"height":h,"rotation":0|90|180|270}` at start and on every rotation or resolution change. The browser maps input against the current SCREEN_INFO.
C10. New command types, server enum plus device handlers:
- `SET_KIOSK {packageName, enabled, lockTask:boolean}` replaces the kioskMode flag.
- `DISABLE_APP {packageName}`, `ENABLE_APP {packageName}`, `LAUNCH_APP {packageName}`.
- `GRANT_PERMISSION {packageName, permission, state:"granted"|"denied"|"default"}`.
- `SET_PROTECTED_PACKAGES {packages:string[]}`: the device refuses UNINSTALL or DISABLE for these packages and for itself.
WIPE requires payload `{confirm:"<deviceId>"}`; the device refuses it otherwise. START_REMOTE payloads carry `iceServers` (C7).
