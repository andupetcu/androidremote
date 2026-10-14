# T5: Web UI authentication wiring, command status and live events
Model: Sonnet. Findings: WU-01, WU-02 (UI side), WU-12, WU-03, WU-04, WU-13, WU-14, WU-20, WU-18 (partial: logout calls the server and clears all state).
Owned: web-ui/src/** EXCEPT the remote-desktop files components/RemoteScreen.tsx, components/RelayRemoteScreen.tsx and lib/FrameDecoder.ts. For hooks/useWebRTC.ts, ONLY change how the /ws URL is built (fetch a ticket); leave everything else for T7. Tests in web-ui/src/tests/** that you add.

Do:
1. All API calls go through the authenticated fetch helper, including EnrollmentModal's three raw fetches and the FileBrowser upload (WU-01, WU-20).
2. C3: before opening `/ws`, `/admin` or `/relay`, call `POST /api/ws-ticket` with the purpose and deviceId and connect with `?ticket=`. Remove any token in WS URLs (WU-12). Get a fresh ticket on every reconnect.
3. WU-03: listen for the event names the server actually emits (`device-event`, etc.); check signaling.ts or app.ts broadcast calls and use one shared constant list.
4. WU-04: one shared admin-socket connection (a context/provider or module singleton), and no reconnect after unmount or logout.
5. WU-13 and WU-14: ask for confirmation in the page (no window.confirm) for reboot, lock, wipe and uninstall. Track queued commands: poll `GET /api/devices/:id/commands` (or use live events) and show pending, delivered, executing, completed, failed and expired with the error text. Don't send a reboot automatically after an install until the install reports completed.
6. Logout: clear the token and all cached state, close the sockets and return to login.
Tests first (vitest/RTL): enrollment calls send Authorization; WS URLs contain `ticket=` and no JWT; the admin socket doesn't reconnect after unmount; a reboot needs confirmation; a failed command shows its error; live `device-event` updates the events list.
