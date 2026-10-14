# T1: Server REST authentication and authorisation (Phase 0)
Model: Sonnet. Findings: SS-01, WU-01 (server side), SS-04, SS-06, AM-01 (server side), SR-01, SS-13, AM-02, SS-12, SS-07, SS-11, SS-08, plus the ticket-issuing half of C3.
Owned: server/src/app.ts, server/src/middleware/**, server/src/services/{enrollmentStore,pairingStore,auditStore,telemetryStore,deviceStore}.ts, server/src/index.ts, and new test files server/test/t1-*.test.ts.
Read only: server/src/services/wsTicketStore.ts (use `wsTicketStore.issue`).

Do:
1. Enrollment: `POST/GET/DELETE /api/enroll/tokens*` require the admin JWT. Only `POST /api/enroll/device` (redemption) stays public. Replace the prefix whitelist with an explicit list of public method+path pairs.
2. Pairing: `/pair/initiate` and `/pair/complete` must not let anyone enrol a device on their own. Completing a pairing requires the admin JWT. Use `crypto.randomInt` for the 6-digit code. If the device side must stay public, that's fine, but the step that issues the device session token must be admin-authorised.
3. Device-facing routes (contract C1): require `X-Session-Token` (or Bearer) on every device route listed in C1, including the ack `PATCH /api/devices/:id/commands/:cmdId` and the file-transfer callbacks. Validate it against the path device ID and its expiry. Remove the tokenless `next()`, keeping only the `ALLOW_TOKENLESS_DEVICES=true` escape hatch, which logs a warning. Match routes with exact patterns (method plus a regex anchored on the full path), not `path.includes`. Admin JWT callers must still be able to use the admin-facing device routes (GET device, list commands and so on). The ack route must accept EITHER a valid device token for that device OR an admin JWT.
4. Telemetry (C2): the device ID comes from the URL, so a deviceId in the body is ignored (or rejected). Apply the same rule to every device route that spreads `req.body`.
5. Default credentials: remove the `admin`/`admin` fallback. If no `ADMIN_PASSWORD_HASH` and no stored password exist, refuse login with a clear error. Add a one-time setup path: an env `ADMIN_INITIAL_PASSWORD` is hashed and stored on first start, then ignored.
6. `app.set('trust proxy', ...)` from env `TRUST_PROXY` (for example `1`) so the login rate limiter keys on the real client IP.
7. `POST /api/ws-ticket` (admin JWT) calls `wsTicketStore.issue({purpose, subject: <jwt sub or 'admin'>, deviceId})`. Validate `purpose` against signaling|admin|relay.
8. Audit: queueing a command (single, batch, policy-triggered) writes an audit entry with actor, device and type. WIPE, RUN_SHELL, REBOOT and LOCK at least.
Tests (write first; supertest against the app): one negative test per hole (anonymous token minting gives 401, tokenless poll gives 401, a token for device A on device B gives 401, the ack with a device token returns 200, body deviceId override is ignored, login with admin/admin fails, the ws-ticket endpoint needs a JWT) and positive tests for the legitimate flows.
