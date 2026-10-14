# T8a-ice: forward START_REMOTE `iceServers` to RemoteSessionService (C7; T8a follow-up)
Test: app/src/test/kotlin/com/androidremote/app/mdm/StartRemotePayloadTest.kt (2 tests).
RED: `Unresolved reference 'StartRemotePayload'`, compile failure.
GREEN: the 2 tests pass. Full `:app:testDebugUnitTest` reports 0 failures, and `:app:compileDebugKotlin` succeeds.
Change: CommandPollingService.executeStartRemote puts `EXTRA_ICE_SERVERS` when the payload carries `iceServers`.
