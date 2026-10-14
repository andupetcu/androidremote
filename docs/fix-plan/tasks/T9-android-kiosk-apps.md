# T9: Android kiosk and app management (starts after T3 and T4)
Model: Sonnet. Findings: AM-07, AM-08, AM-09, AM-10, AM-16, AM-17, AM-24, plus C10 on the device side.
Owned: app/.../admin/** (BootReceiver, DeviceOwnerManager, DeviceOwnerReceiver, PackageUpdateReceiver), app/.../mdm/BootReceiver.kt, new app/.../kiosk/**, app/src/main/AndroidManifest.xml (T4 is finished), the command dispatch `when` and SET_* handlers in app/.../mdm/CommandPollingService.kt (T3 is finished; keep its structure), plus tests.

Do:
1. Real kiosk (AM-07): SET_KIOSK uses `setLockTaskPackages(admin, [pkg, own])` and starts the target in lock task through a trampoline activity, OR (when lockTask is false) `addPersistentPreferredActivity` for HOME, so the player is the launcher. Disable the keyguard and status bar for kiosk (`setKeyguardDisabled`, `setStatusBarDisabled`). Handle LOCKED_BOOT_COMPLETED (directBootAware receiver) and BOOT_COMPLETED: merge the two boot receivers into one deterministic path (AM-10).
2. A watchdog in the polling service: if a kiosk or foreground app is configured and isn't running in the foreground, relaunch it, with a cooldown. Listen for PACKAGE_REPLACED/PACKAGE_ADDED for the target and relaunch after an update (AM-08). Auto-update installs only in a maintenance window if one is configured, otherwise immediately, then relaunch.
3. AM-09: boot and foreground preferences can be removed (SET_KIOSK enabled=false clears them). SYNC_POLICY only changes the fields it carries.
4. C10 app management: DISABLE_APP/ENABLE_APP (`setApplicationHidden` or `setPackagesSuspended`), LAUNCH_APP, GRANT_PERMISSION (`setPermissionGrantState`), SET_PROTECTED_PACKAGES. UNINSTALL and DISABLE refuse protected packages and self (AM-16). WIPE requires `confirm == deviceId`.
5. AM-24: fix the silent-mode handling so a Device Owner doesn't clobber secure settings (use DPM APIs or only touch the fields that were provided).
Tests first: kiosk policy decisions (extract a KioskPolicy class), watchdog relaunch decision with cooldown, boot path ordering, protected-package refusal, the WIPE confirm guard, partial SYNC_POLICY merge.
