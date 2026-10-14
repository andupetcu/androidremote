# BUILD: the bundled screen-server APK must be freshly built
Found during final integration (also flagged in an earlier review): `copyScreenServerApk` copied `screen-server-debug.apk` with no dependency on building it.
RED: after `assembleDebug`, `app/src/main/assets/screen-server.apk` was 837,037 bytes (19:10), while the freshly built `screen-server-debug.apk` was 845,663 bytes (19:11). Devices would get a stale helper without T4's `-u` peer check and T8b's rotation and keyframe support.
Fix: `dependsOn(":screen-server:assembleDebug")` on the copy task.
GREEN: delete the asset, then `./gradlew clean assembleDebug` gives BUILD SUCCESSFUL, and `cmp` of the asset against the fresh screen-server build is identical. app-debug.apk contains assets/screen-server.apk.
Not changed: the copy still always takes the debug variant. Release signing and packaging of the helper is a separate decision.
