# T6: Server command lifecycle, APK pipeline, ICE servers (starts after T1)
Model: Sonnet. Findings: SR-02, SR-03, SR-04, SR-18, SR-12, SR-15, SR-16, SS-10, SR-11, SS-14, WU-10 (server side), AR-13 (server side).
Owned: server/src/services/{commandStore,appPackageStore,storageProvider,appSyncService,policyStore}.ts, server/src/db/schema.ts, the command, heartbeat, poll, upload, app-package, policy-sync and START_REMOTE route handlers in server/src/app.ts (T1 is finished with app.ts before you start; don't undo its auth work), plus new tests server/test/t6-*.test.ts.

Do:
1. C5: add `lease_expires_at` and `expires_at` columns through a transactional, idempotent migration (SR-16). Poll returns pending commands plus delivered commands with an expired lease, sets the lease, and never returns expired commands, marking them `expired`. Acks scoped to the device in the URL (SR-12). A duplicate ack is idempotent.
2. SR-02: the heartbeat no longer calls getPendingCommands. Use a non-consuming existence query for the SYNC_APPS check.
3. SR-04 TTLs per C5. SR-18: policy sync collapses into one pending command per device and type (supersede the older pending one).
4. SR-15: `updateDeviceStatus('offline')` keeps `last_seen_at`.
5. C6 and SS-10: validate the package name, put the storage path inside the root (resolve it and check the prefix), stream uploads to disk with multer diskStorage instead of memory (SR-11), compute sha256 while streaming, verify the APK zip magic and AndroidManifest presence, delete files on DB failure, and put `sha256` in every INSTALL_APK payload (direct, policy, auto-update). The downloads route for APKs requires a device token or the admin JWT; it is no longer public.
6. C7: `GET /api/ice-servers` with coturn REST credentials from env, plus `iceServers` in START_REMOTE payloads. SS-14: build URLs from env `PUBLIC_BASE_URL`, never from the Host header.
Tests first for each item (lease redelivery, expiry, the heartbeat doesn't consume, supersede, sha256 in payload, traversal package names rejected, streaming upload (large file stays out of the heap; assert diskStorage is used), ice-servers credential format and expiry).
