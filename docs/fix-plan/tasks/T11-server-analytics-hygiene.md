# T11: Server analytics, retention, robustness and admin sessions (starts after T6)
Model: Sonnet. Findings: SR-08, SR-09, SR-10, SR-13, SR-14, SR-17, SS-09, plus the server side of C10 and the telemetry batch endpoint for T10.
Owned: server/src/services/{telemetryStore,eventStore,auditStore,settingsStore,groupStore,deviceStore}.ts, server/src/db/schema.ts, server/src/index.ts, server/src/middleware/auth.ts, the telemetry, events, audit, auth/logout and command-type parts of server/src/app.ts, new route modules under server/src/routes/**, plus tests.

Do:
1. SR-09: write telemetry history rows on each report and batch. Add `POST /api/devices/:id/telemetry/batch` (device token). The history API supports `from`, `to` and `bucket` (minute/hour/day) with downsampling in SQL.
2. SR-08: emit battery-low only on a state transition (with hysteresis). Schedule retention purges hourly with env-configurable days: telemetry history 30, events 90, audit 365, finished commands 30.
3. SR-10: add indexes for the hot queries (events by device and time, commands by device and status, telemetry history by device and time) through an idempotent migration.
4. SR-13: graceful shutdown (stop accepting, close the WebSocket servers, close the DB), plus process `unhandledRejection`/`uncaughtException` handlers that log and exit non-zero.
5. SS-09: admin sessions get a `jti` and a revocation table; `POST /api/auth/logout` revokes; changing the password revokes all sessions; shorten the JWT lifetime to 8 h.
6. C10: add the new command types to the enum and validation (DB CHECK through migration, Zod schemas), and audit them. WIPE requires `confirm == deviceId` server-side as well.
7. SR-17: move the route groups you touch out of app.ts into `src/routes/*.ts` routers (telemetry, events, audit, auth). Keep behaviour identical; existing tests must stay green. SR-14: add the critical-path tests that are missing (auth gate matrix, command lifecycle end to end, relay auth smoke).
Tests first for each behaviour.
