#!/usr/bin/env bash
#
# Install the debug APK and re-toggle the AccessibilityService.
#
# Android disconnects AccessibilityService bindings after app reinstall,
# causing dispatchGesture() to silently no-op. Toggling the service
# off/on forces the framework to re-bind.
#

set -euo pipefail

APK="${1:-app/build/outputs/apk/debug/app-debug.apk}"
SERVICE="com.androidremote.app/com.androidremote.app.service.InputInjectionService"

if [ ! -f "$APK" ]; then
  echo "APK not found: $APK"
  echo "Run ./gradlew :app:assembleDebug first."
  exit 1
fi

echo "Installing $APK ..."
adb install -r "$APK"

echo "Re-toggling AccessibilityService ..."
adb shell settings put secure enabled_accessibility_services '""'
adb shell settings put secure accessibility_enabled 0
sleep 2
adb shell settings put secure enabled_accessibility_services "$SERVICE"
adb shell settings put secure accessibility_enabled 1

echo "Done. AccessibilityService re-bound."
