# Leftovers (2026-10-15)

1. **Installer download streamed.** `GET /api/downloads/installer/:platform` streams the base installer from disk and appends the config trailer, instead of reading up to 200 MB into memory. Content-Length = file size + trailer.
   - RED: `t11-api.test.ts` "streams the installer download" failed because `readFileSync` was called on `windows-x64.exe`.
   - GREEN: the same test passes; the body is byte-identical (base + JSON + length + `ARCFG` magic). Server suite: 396/396.
2. **Per-package auto-update backoff.** A failed or timed-out automatic install of a version waits 5 min, then 10, 20 … up to 6 h before it is tried again. A newer version on the server is tried at once; success clears it; other packages are unaffected. The state lives in memory, so a restart of the service retries once.
   - RED: `UpdateBackoffTest` did not compile (no `UpdateBackoff`).
   - GREEN: 6/6.
3. **Unused `feature-screen` module removed** (no code referenced it since the root-only remote desktop). Clean `./gradlew clean test assembleDebug`: 1083 test runs, 0 failed, 12 skipped (the old 1157 included the module's 40 tests in both variants).
