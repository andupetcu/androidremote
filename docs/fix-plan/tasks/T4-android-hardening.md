# T4: Android device hardening
Model: Sonnet. Findings: AR-02, AR-08, AM-14, AM-15, AM-06, AR-17, AR-18, AM-23, AR-16.
Owned: feature-input/** (including AdbShellInjector.kt and its tests), screen-server/**, app/.../MainActivity.kt, app/src/main/AndroidManifest.xml, app/src/main/res/xml/**, app/.../ui/SessionStorage.kt, app/.../controller/{InputHandler,TextInputHandler}.kt, app/.../service/ScreenServerClient.kt, plus tests you add.

Do:
1. AR-02: text injection must never go through `sh -c` with interpolated text. Exec `su 0 input text <arg>` (or `input text` without root) as an argv array. Encode spaces as `%s` as `input text` expects, and reject or strip control characters (\n, \r, \t, NUL). Also check the other `runShellCommand` callers build their commands from typed values only.
2. AR-16: the root/shell probe must not run on the Main thread, and a failed probe must be retried later instead of being cached forever.
3. AR-08: the screen-server's abstract socket must authenticate its peer. On accept, check `LocalSocket.getPeerCredentials().uid` equals the app's uid (pass the expected uid to the server process as an argument when launching it) and drop other peers.
4. AM-14: MainActivity ignores `enrollment_token`/`server_url` intent extras when the device is already enrolled, and when the caller isn't the app itself or adb/MDM provisioning. At minimum, ignore them once enrolled and require explicit user confirmation on the screen otherwise.
5. AM-15: set `android:allowBackup="false"` (or dataExtractionRules excluding everything). SessionStorage must not silently fall back to plaintext: if EncryptedSharedPreferences fails, log an error and use the Android Keystore-backed fallback, or fail closed with a visible error.
6. AM-06/AR-17: the network security config can't express subnets. Replace the fake IP entries with a documented approach: release builds allow cleartext only to hosts listed in a build-time resource (`server_cleartext_hosts`), and the default is HTTPS only. Debug builds may allow cleartext. Document it in the evidence file.
7. AR-18/AM-23: stop logging session tokens, enrollment tokens, typed text and full URLs with tokens. Redact.
Tests first: the escape/argv builder (newline and `; reboot` payloads never become shell syntax); the probe runs off-main and retries; the peer-uid check rejects other uids (pure function); the MainActivity extras guard logic (extract it into a testable class); the log redaction helper.
