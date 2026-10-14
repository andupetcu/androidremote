# W0c: Android unit tests compile and run

Findings: none directly. Groundwork for the Android test baseline. No production code changed.
Owned files: `app/src/test/**` only.

## Before
- `./gradlew :app:testDebugUnitTest` -> `:app:compileDebugUnitTestKotlin FAILED`, 0 tests executed.
  ```
  e: .../app/src/test/kotlin/com/androidremote/app/ui/ScreenStateTest.kt:14:37 Unresolved reference 'ERROR'.
  e: .../app/src/test/kotlin/com/androidremote/app/ui/SessionStorageTest.kt:25:19 Cannot access 'constructor(enrollmentPrefs: SharedPreferences, securePrefs: SharedPreferences): SessionStorage': it is private in 'com/androidremote/app/ui/SessionStorage'.
  ```
- Other modules were not measured separately before this task. Their test sources are untouched by W0c.

## After
- `./gradlew :app:testDebugUnitTest`: BUILD SUCCESSFUL, 86 tests, 0 failures, 0 errors, 0 skipped.
- `./gradlew cleanTest test` (all modules, fresh results): BUILD SUCCESSFUL.
- `./gradlew :app:compileDebugKotlin --rerun-tasks`: BUILD SUCCESSFUL.

## Per-module counts (fresh run, `cleanTest test`)
| Module | Variant | Classes | Tests | Fail | Err | Skip |
|---|---|---|---|---|---|---|
| app | testDebugUnitTest | 12 | 86 | 0 | 0 | 0 |
| app | testReleaseUnitTest | 12 | 86 | 0 | 0 | 0 |
| core-crypto | test | 3 | 23 | 0 | 0 | 0 |
| core-protocol | test | 2 | 35 | 0 | 0 | 0 |
| core-transport | test | 8 | 72 | 0 | 0 | 12 |
| feature-camera | debug / release | 1 | 31 | 0 | 0 | 0 |
| feature-files | debug / release | 2 | 51 | 0 | 0 | 0 |
| feature-input | debug / release | 9 | 73 | 0 | 0 | 0 |
| feature-screen | debug / release | 3 | 43 | 0 | 0 | 0 |
| screen-server | - | - | NO-SOURCE | - | - | - |

The 12 skipped tests are in `core-transport` (`RemoteSessionTest`, `SignalingClientTest`). They were already skipped in the existing sources and are outside this task.

## Test changes (app/src/test only)
Production code is unchanged. Each change is a test-side fix.

1. `ui/ScreenStateTest.kt`: `ERROR` no longer exists. The index test now covers the current states (PERMISSIONS 0, ENROLLMENT 1, READY 2, PAIRING 3, CONNECTED 4, MANAGED 5). The uniqueness test is unchanged.
2. `ui/SessionStorageTest.kt`: the private constructor is replaced with the public `SessionStorage.create(context)` factory under `RobolectricTestRunner` (JUnit4, run through the vintage engine as in `QrCodeGeneratorTest`). The test now uses real prefs and asserts round-trip values, not mock `verify` calls. `clears session data` asserts the values are null after `clear()`.
3. `testsupport/TestSupport.kt` (new, test-only):
   - `TestApplication`: a no-op Robolectric Application. `AndroidRemoteApplication.onCreate` loads the WebRTC native library, which is not available on the host JVM. Used by `SessionStorageTest` and `QrCodeGeneratorTest`.
   - `LogStub`: mocks `android.util.Log` (`d/i/w/e/v`), because the JVM android.jar stub throws "not mocked". Wired into `InputHandlerTest`, `SessionControllerTest` and `WebRtcDataChannelTest` in `@BeforeEach` and `@AfterEach`.
4. `controller/SessionControllerTest.kt` `disconnect transitions to Disconnected`: `SessionController.disconnect()` now calls `session.closeSync()` and `disconnectSignaling()`, not `disconnect()`. The test verifies `closeSync()`. This is the closest current behaviour.
5. `webrtc/WebRtcDataChannelTest.kt`: the relaxed mock returns the first enum constant (`CONNECTING`) for `state()`, so `send()` short-circuited before the native call. The setup now stubs `state()` to `OPEN`.
6. `ui/PermissionHelperTest.kt` `hasAllRequiredPermissions ...`: production no longer checks accessibility there (notification and battery only). The test is renamed to "does not depend on accessibility service" and asserts `true`.
   - Caveat: under the JVM stub `Build.VERSION.SDK_INT` is 0, so the notification and battery checks take their default branches. This test is weak and does not prove the notification and battery logic.

## KNOWN-BUG
None. After the harness and stale-assertion fixes, no app test fails for a real production bug, so nothing is `@Ignore`d.

## Needs from other owners
None. `app/build.gradle.kts` was not changed.

## Could not fix or test
- `PermissionHelper.hasAllRequiredPermissions` coverage (see caveat above). Testing it properly needs Robolectric, or a seam that injects the notification and battery checks.
