# T12: Web UI kiosk, app management, analytics, pagination (starts after T5 and T7)
Model: Sonnet. Findings: WU-15, WU-16, WU-17, WU-19, plus the UI for C10.
Owned: web-ui/src/** except the remote-desktop files (RemoteScreen, RelayRemoteScreen, useWebRTC, FrameDecoder).

Do:
1. WU-15: a device "Kiosk" panel: pick the app, set lock task on or off, see the applied state from command status and device telemetry. App management actions: disable/enable, launch, permissions, protected packages, all with confirmation where destructive. WIPE asks the user to type the device ID (C10).
2. WU-16: one polling scheduler with backoff and visibility pause, no duplicate fetches, and live events replacing polling where available.
3. WU-17: server-driven pagination for devices, events, audit, apps and telemetry (use the server's limit/offset params, which already exist in most routes; note any missing params under "Needs from other owners"), and virtualise long tables.
4. WU-19: telemetry charts (battery, storage, memory, network) from the downsampled history API (`bucket`), loaded lazily with a bounded range. Use a light chart library already in package.json if present; otherwise SVG.
Tests first.
