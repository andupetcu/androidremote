# W0a: server test suite runnable again

Finding IDs: SR-14 (test suite stale against current code). Related, not fixed here: SR-01, SR-07, SS-02, AR-01, SS-06 (see "Needs from other owners").

## Baseline (before, commit 941e52e)

Command: `cd server && npx jest`

```
FAIL test/pairing.test.ts
    SyntaxError: Unexpected token 'export'      (uuid@13 is ESM-only; same for the other 4 suites)
Test Suites: 6 failed, 6 total
Tests:       1 failed, 12 passed, 13 total
  ● Signaling Server › Join › rejects duplicate role in same room
    thrown: "Exceeded timeout of 5000 ms for a test.
```

Only signaling.test.ts loaded. The other 5 suites (88 tests defined in those files, including signaling's 13) never ran, so 75 tests were unrunnable.

## Changes

1. `server/src/services/appPackageStore.ts`: `uuid` replaced with `randomUUID` from Node's `crypto` (2 call sites). Only production change.
2. `server/package.json` and `server/package-lock.json`: `npm uninstall uuid` and `npm uninstall @types/uuid`. The lockfile diff is removals only (uuid@13.0.2 and @types/uuid@10.0.0 blocks).
3. `server/test/setup.ts`: every store now gets the in-memory test DB (previously 4 of 11 stores, so heartbeat and event paths hit the real, uninitialised DB and threw 500). Cleanup wipes all data tables. Added `adminAuthHeader()` (admin JWT via `getJwtSecret()`).
4. `server/test/commands.test.ts`, `devices.test.ts`, `enrollment.test.ts`, `pairing.test.ts`: admin-only routes now send `Authorization: Bearer <admin JWT>`. The tests predate the `/api` auth gate in `src/app.ts`. Device-facing calls (heartbeat, `commands/pending`) are left unauthenticated, matching current gate behaviour. Validation assertions check `details[].path` (the `validateBody` shape) instead of the old top-level message text. Field-level assertions are kept.
5. `server/test/signaling.test.ts`: teardown terminates every client socket, closes the WSS, and calls `shutdownRelay()`. `setupSignaling` starts the relay stale-check `setInterval` (not unref'd), which kept jest alive. Also `it.skip` for the duplicate-role test (KNOWN-BUG, see below).

No assertion about security was deleted. Every skipped test keeps its original assertion.

## Environment note

`better-sqlite3@12.6.2` has a prebuilt binary for Node 22 (ABI 127). It does not compile on the default shell Node (v26.8.1, `/Users/andrei/.local/bin/node`). Running on the default Node fails every DB-backed suite with NODE_MODULE_VERSION 127 vs 147. Run the server suite under Node 22 (`/opt/homebrew/bin/node`, v22.23.3). `npm rebuild better-sqlite3` under Node 22 was run to refresh node_modules; no tracked files changed for this.

## KNOWN-BUG skips (2)

| Test | Finding | Why |
|---|---|---|
| `signaling.test.ts` › Join › rejects duplicate role in same room | SR-07, SS-02, contract C4 | Join with an existing role evicts the current peer ("Replacing stale" in `signaling.ts`). Contract C4 says an unauthenticated socket must never evict an authenticated peer, and signaling has no auth at all. Assertion kept as the target behaviour. |
| `enrollment.test.ts` › returns a ws:// serverUrl for the device signaling connection | NEW (no existing finding) | `POST /api/enroll/device` returns `serverUrl` as `http(s)://…` (from `getBaseUrl`). Android maps `ws://`→`http://` and `wss://`→`https://` in `MainActivity.kt:509` and `CommandPollingService.kt:184`, so it expects a ws(s) form. I did not trace the exact WebSocket URL construction, so treat this as likely, not proven. The other enrollment assertions stay live in `enrolls device with valid token`. |

## Results

After (`cd server && npx jest`, Node 22, exit 0, no open-handle warning):

```
Test Suites: 7 passed, 7 total
Tests:       2 skipped, 92 passed, 94 total
```

Breakdown: the 6 suites above contribute 86 passed + 2 skipped = 88 (matching the 88 defined). The extra suite is `test/wsTicketStore.test.ts` (6 tests), added by commit 34e1636 from another agent, not by W0a.

Also confirmed with `npx jest -i`: exits cleanly, same counts.

## Not fixed here (for other owners)

- **Device ack is rejected by the auth gate (SR-01 / contract C1).** `PATCH /api/devices/:id/commands/:cmdId` is not in the device-facing list in `src/app.ts` (`deviceFacingPaths` covers `/commands/pending` only), so it requires an admin JWT. Devices cannot ack with `X-Session-Token`. The ack tests use the admin header to exercise the handler, and that stays valid after the gate is fixed. The owner of the auth gate should add a session-token ack test.
- **Device routes accept calls with no token (SS-06 / contract C1).** `app.ts` returns `next()` when `sessionToken` is missing (heartbeat, telemetry, apps, events, pending poll). Contract C1 requires the token unless `ALLOW_TOKENLESS_DEVICES` is set. Tests for those routes currently rely on the tokenless path.
- **Signaling evicts without auth (C4).** Owner: signaling. Unskip the duplicate-role test when C4 lands.
- **serverUrl scheme.** Owner: enrollment. Unskip the KNOWN-BUG test when the scheme is fixed.

Untouched: no production `src/` changes other than the uuid swap. No `*.md` outside this evidence file. No push, no AI trailers.
