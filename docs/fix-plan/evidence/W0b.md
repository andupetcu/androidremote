# W0b: web UI test suite made trustworthy

Findings: none directly; groundwork for WU-05 and WU-20 (tests added, skipped as KNOWN-BUG).

## Counts
- Before: `cd web-ui && npx vitest run` -> 26 failed / 18 passed (44 tests, 3 files)
- After: 44 passed / 2 skipped (46 tests, 3 files passed), exit code 0, no unhandled errors, no act() warnings.
  (The Node "ExperimentalWarning: localStorage is not available" line is printed by Node at worker start, not by a test.)

## Root causes (all test-environment, no production code touched)
All 25 of the "environment" failures came from three harness problems in `web-ui/src/tests/setupTests.ts`:
1. `localStorage`: Node's experimental global shadows jsdom's and throws without `--localstorage-file`. `apiFetch` reads `auth_token`, threw, and FileBrowser rendered "Failed to load files". Fix: in-memory Storage stub.
2. Relative `fetch('/api/...')` is not resolvable in Node fetch (browser resolves it). Fix: wrapper resolving against `window.location.origin` so MSW relative handlers match.
3. jsdom `HTMLCanvasElement.getContext()` returns null, so `new FrameDecoder(canvas)` threw in RemoteScreen's effect (`Cannot set properties of null (setting 'fillStyle')`). Fix: no-op 2D context stub.
Plus 1 stale test (below) and a mock missing `disconnect`.

## Per-test decisions
| Test | Decision | Notes |
|---|---|---|
| RemoteScreen: displays canvas when connected | (a) stale | Asserted text /connected/; component shows no status text when connected. Now asserts canvas + Back/Home buttons present and no "connecting" text. |
| RemoteScreen: notifies parent of connection state changes | (a) harness | canvas ctx stub; also useWebRTC mock now returns `disconnect` |
| RemoteScreen: tap pointer down/up | (a) harness | canvas ctx stub |
| RemoteScreen: calculates normalized coordinates | (a) harness | canvas ctx stub (assertion unchanged) |
| RemoteScreen: swipe on drag | (a) harness | canvas ctx stub |
| RemoteScreen: small movement is tap | (a) harness | canvas ctx stub |
| RemoteScreen: long press after hold | (a) harness | canvas ctx stub |
| RemoteScreen: cancels long press on move | (a) harness | canvas ctx stub |
| RemoteScreen: Escape -> back | (a) harness | canvas ctx stub |
| RemoteScreen: Ctrl+H -> home | (a) harness | canvas ctx stub |
| RemoteScreen: hook receives deviceId/signalingUrl | (a) harness | canvas ctx stub |
| FileBrowser: all 15 previously failing tests (list, icons, sizes, navigation x3, selection x2, upload x3, download x2, delete confirmation, refresh) | (a) harness | localStorage + relative fetch fixes; assertions unchanged |
| FileBrowser: upload error / upload progress / uploaded successfully | (a) harness | pass against current component; the upload still lacks auth (see KNOWN-BUG) |

## New tests added (skipped, real product bugs; verified they FAIL when unskipped)
- `RemoteScreen.test.tsx` "maps taps relative to the rendered video area, not the whole canvas element" - `// KNOWN-BUG: WU-05`. Square video letterboxed in a 1000x2000 element; tap on the picture's top edge should give y=0, component gives 0.25 (ignores object-fit:contain bars). Unskipped result: `expected vi.fn() to be called with { type: 'TAP', x: 0.5, y: 0 }`.
- `FileBrowser.test.tsx` "sends the auth token with the upload request" - `// KNOWN-BUG: WU-20`. Upload uses bare `fetch`, no Authorization header. Unskipped result: `expected null to be 'Bearer jwt-123'`.

## Files changed
- web-ui/src/tests/setupTests.ts, RemoteScreen.test.tsx, FileBrowser.test.tsx

## Needs from other owners
None. WU-05 / WU-20 fixers should remove `it.skip` on the two tests above.
