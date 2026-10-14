# Testing the review fixes (branch `fix/review-2026-10-14`, local only)

This branch fixes the review findings (https://claude.ai/artifact/X8T8wTqqgLhWwU974EgrUf). Each task's red-to-green proof is in `docs/fix-plan/evidence/`, and cross-component notes are in `FOLLOWUPS.md`.
Everything here is verified by automated tests only. Nothing has run against a real device or a deployed server yet. This guide is the checklist for doing that.

## 1. Run the automated suites
| Component | Command | Expected |
|---|---|---|
| Server | `cd server && PATH=/opt/homebrew/bin:$PATH npx jest` (Node 22: better-sqlite3 doesn't build on Node 26) and `npx tsc --noEmit` | all suites green |
| Web UI | `cd web-ui && npx vitest run`, `npx tsc -b` and `npx eslint src` | green, 0 lint errors |
| Android | `export JAVA_HOME=/opt/homebrew/opt/openjdk@17 ANDROID_HOME=$HOME/Library/Android/sdk; ./gradlew test assembleDebug` | BUILD SUCCESSFUL |

## 2. Server configuration (breaking changes)
Required:
- `JWT_SECRET`: a long random value. Production refuses to start without it.
- `ADMIN_INITIAL_PASSWORD` (8 characters or more; hashed on first start, then remove it) or `ADMIN_PASSWORD_HASH`. **The admin/admin fallback is gone**, so login is refused until one of these is set.
- `PUBLIC_BASE_URL`, for example `https://mdm.example.com`. It's used for enrolment responses, installers, START_REMOTE and provisioning. URLs are never built from the Host header.
- `TRUST_PROXY=1` behind Nginx or Nginx Proxy Manager, so login rate limiting is per client.

Remote desktop across NAT (run your own coturn):
- `TURN_URLS` (e.g. `turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349`), `TURN_SECRET` (= coturn `static-auth-secret`, with coturn `use-auth-secret`), optional `TURN_TTL_SECONDS` (3600), `STUN_URLS`.
- The old hard-coded public TURN credentials were removed from the web UI. Without TURN, only same-LAN and direct-NAT sessions connect.

Rollout switch:
- `ALLOW_TOKENLESS_DEVICES=true` lets devices running the OLD agent (which sends no token) keep polling, so they can receive the new APK. Remove it once every device runs the new build. Without it, old agents get 401 and stop receiving commands.

Optional tuning (defaults are fine): `JWT_EXPIRES_IN` (8h), `COMMAND_LEASE_MS` (5 min), `COMMAND_TTL_SHORT_MS` (15 min, for REBOOT, LOCK, WIPE and START_REMOTE), `COMMAND_TTL_DEFAULT_MS` (7 days), `COMMAND_EXECUTING_TIMEOUT_MS`, `RETENTION_TELEMETRY_DAYS` (30), `RETENTION_EVENTS_DAYS` (90), `RETENTION_AUDIT_DAYS` (365), `RETENTION_COMMANDS_DAYS` (30), `TELEMETRY_REPORT_INTERVAL_MS` (60 s), `DEVICE_OFFLINE_AFTER_MS` (2 min), `UPLOADS_DIR`, `INSTALLERS_DIR`, `AGENT_BINARIES_DIR`, `AGENT_PACKAGE_NAME`, `WS_*` and `RELAY_*` limits, `BCRYPT_ROUNDS` (12).

Database: schema migrations run automatically at startup (new command columns and statuses, indexes, telemetry history, admin session revocation). They were tested on in-memory databases only. **Back up the SQLite file first and test the upgrade on a copy of the production DB.**

## 3. Android build notes
- Release builds are HTTPS-only. The release default `PAIRING_SERVER_URL` (`http://192.168.68.209:7899`) no longer works in release builds; use HTTPS (or add an exact host name to the release network security config). Debug builds still allow cleartext.
- `BuildConfig.ALLOW_UNVERIFIED_APK=false`: the device refuses any INSTALL_APK without a matching `sha256`. The server adds it automatically for uploaded APKs.
- The screen-server helper is now rebuilt before being bundled (it was stale before). It requires the `-u <uid>` argument, which the app passes.
- Per device, once: `adb shell cmd notification allow_dnd com.androidremote.app` (Do-Not-Disturb for silent mode).

## 4. Manual test checklist (one test device, Device Owner)
Security:
1. `curl -X POST $URL/api/enroll/tokens` with no auth returns 401. `GET /api/devices/<id>/commands/pending` with no token returns 401. Opening `wss://…/ws` or `/admin` with no ticket returns 401.
2. Log in, open a remote session, then try to join the same device room from a second browser profile. The first session is not evicted.
3. In remote control, type text containing a newline followed by `reboot`. The device types it and does **not** reboot.

Commands:
4. Reboot from the UI: there's a confirmation dialog, the device reboots, and the command shows completed (it used to stay "delivered" forever).
5. Queue a REBOOT while the device is offline for more than 15 minutes, then bring it online. The command shows **expired** and the device doesn't reboot.
6. Kill the agent during an install. After restart the command is redelivered (5 min lease) and is not run twice.

Apps and kiosk:
7. Upload an APK and install it: it succeeds. Tamper with the stored file: the device refuses with "sha256 mismatch".
8. Kiosk tab: set the player with lock task. The player starts pinned. Force-stop or crash it, and it relaunches within about 30 s. Update the player APK, and it relaunches after the update. Reboot or power-cycle, and the player comes back (direct boot is handled).
9. Disable or enable an app, protect a package (uninstall refused), and wipe (asks you to type the device ID).

Remote desktop:
10. Rooted device: the session starts, rotate the device and the picture and taps follow, tap in the letterbox area is ignored. Close the browser tab and the device stops capture within about 30 s.
11. Non-rooted device: the viewer shows "consent required", and tapping "Start now" on the device starts capture.
12. Toggle Wi-Fi briefly during a session. Video recovers without restarting the session.
13. Over mobile data or behind NAT (TURN configured): the session connects.

Analytics:
14. Device Overview, then Trends: battery, storage, memory and network charts for 24 h and 7 d. Turn off the network for 10 minutes and back on: the gap is filled from the device buffer.
15. Provisioning: Settings, then QR. Factory-reset a device and scan it. The agent downloads from `/api/provisioning/agent.apk` and the checksum matches.

## 5. Known limits and decisions left to you
- Silent remote desktop without root isn't possible on stock Android. Options: root (current), an OEM platform-signed build, or the MediaProjection "Start now" tap (now wired).
- Commands the Android agent doesn't implement (UNLOCK, SEND_MESSAGE, PLAY_SOUND, SET_BRIGHTNESS, RUN_SHELL, file commands…) are marked unsupported in the UI for Android devices. Implement or remove them as you prefer.
- Kiosk foreground detection needs usage-stats access. The Device Owner self-grants it where the OEM allows; otherwise the watchdog relaunches more often than needed.
