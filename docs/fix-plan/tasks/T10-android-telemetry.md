# T10: Android telemetry (starts after T3)
Model: Haiku. Findings: AM-18, AM-19.
Owned: app/.../mdm/TelemetryCollector.kt, new app/.../mdm/telemetry/** (buffer), plus tests. Wiring in CommandPollingService is limited to calling the collector (coordinate: T9 owns CommandPollingService in the same wave; add only a single method call if needed and describe it in the evidence under "Needs from other owners" instead of editing it).

Do:
1. Buffer telemetry samples on the device while offline: a bounded file or SharedPreferences ring of 1000 samples. Flush in batches to the server when it's reachable. The server accepts a batch at `POST /api/devices/:id/telemetry/batch` (T11 builds it). Fall back to the single endpoint if the batch endpoint returns 404.
2. Honour the server-provided report interval from policy or the poll response; default 60 s.
3. AM-19: request a fresh location when location is enabled and permission granted, with a max age of 15 min, else null. Don't cache forever.
Tests first: ring buffer bounds and order, flush retry on failure, interval honoured, location staleness rule.
