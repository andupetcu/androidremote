# T19-server: store the device's `rooted` telemetry flag (remote desktop is root-only)
Owner decision 2026-10-14: remote desktop supported on rooted devices only. The device reports `rooted` and the UI uses it to disable Connect.
Test: server/test/t19-rooted.test.ts (4).
RED: 3 failed (the field was stripped by the schema), 1 passed (null before any report).
GREEN: 4 passed. Full suite green twice, tsc clean.
Change: `rooted` added to the telemetry schema (single and batch), the store (column `rooted INTEGER` via idempotent addColumnIfMissing), and the latest-telemetry response (null when unknown).
