# Android Remote App Installation Guide

Install the Android Remote MDM app and optional screen server on Android devices.

## Prerequisites

- Android device with USB debugging enabled
- ADB installed on your computer
- Root access on the device (for full MDM capabilities)

### Enable USB Debugging

1. Go to **Settings > About Phone**
2. Tap **Build Number** 7 times to enable Developer Options
3. Go to **Settings > Developer Options**
4. Enable **USB Debugging**

## Part 1: Install Android Remote APK

### Option A: Standard Installation (Non-Root)

```bash
# Connect device and verify connection
adb devices

# Install the APK
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

### Option B: System App Installation (Root Required)

Install as a system app for persistent operation:

```bash
# Connect device
adb devices

# Get root shell
adb root
adb remount

# Push APK to system apps
adb push app/build/outputs/apk/debug/app-debug.apk /system/priv-app/AndroidRemote/AndroidRemote.apk

# Set correct permissions
adb shell chmod 644 /system/priv-app/AndroidRemote/AndroidRemote.apk
adb shell chown root:root /system/priv-app/AndroidRemote/AndroidRemote.apk

# Reboot to apply
adb reboot
```

### Option C: Device Owner Mode (Recommended for MDM)

Device Owner mode provides silent permission grants and full MDM control:

```bash
# 1. Factory reset the device (required for Device Owner)
#    Settings > System > Reset > Factory data reset
#    OR via ADB:
adb shell am broadcast -a android.intent.action.FACTORY_RESET

# 2. During setup, skip all accounts (don't add Google account yet)

# 3. Enable USB debugging again after setup

# 4. Install the app
adb install -r app/build/outputs/apk/debug/app-debug.apk

# 5. Set as Device Owner
adb shell dpm set-device-owner com.androidremote.app/.admin.DeviceOwnerReceiver

# Expected output:
# Success: Device owner set to package com.androidremote.app

# 6. Verify Device Owner status
adb shell dumpsys device_policy | grep -A 5 "Device Owner"
```

#### Remove Device Owner (if needed)

```bash
# From app settings (if accessible)
# Or via ADB with root:
adb root
adb shell dpm remove-active-admin com.androidremote.app/.admin.DeviceOwnerReceiver
```

## Part 2: Install Screen Server (Optional)

The screen server provides low-latency screen mirroring via a system-level service.

### Build Screen Server

```bash
cd /Users/andrei/Downloads/Projects/android-remote

# Build the screen server module
./gradlew :screen-server:assembleDebug
```

### Install Screen Server

```bash
# Connect device with root
adb root

# Push the screen server JAR/DEX to device
adb push screen-server/build/outputs/apk/debug/screen-server-debug.apk /data/local/tmp/screen-server.apk

# Extract classes.dex from APK
adb shell "cd /data/local/tmp && unzip -o screen-server.apk classes.dex"

# Set permissions
adb shell chmod 755 /data/local/tmp/classes.dex
```

### Start Screen Server Manually

```bash
# Start via app_process (runs with system privileges)
adb shell "CLASSPATH=/data/local/tmp/classes.dex app_process / com.androidremote.screenserver.Server"

# Or run in background
adb shell "CLASSPATH=/data/local/tmp/classes.dex nohup app_process / com.androidremote.screenserver.Server > /dev/null 2>&1 &"
```

### Start Screen Server via Script

```bash
# Push the start script
adb push scripts/start-screen-server.sh /data/local/tmp/
adb shell chmod +x /data/local/tmp/start-screen-server.sh

# Run the script
adb shell /data/local/tmp/start-screen-server.sh
```

### Auto-Start Screen Server on Boot

```bash
# Create init.d script (requires root and init.d support)
adb root
adb shell "cat > /system/etc/init.d/99screenserver << 'EOF'
#!/system/bin/sh
sleep 10
CLASSPATH=/data/local/tmp/classes.dex app_process / com.androidremote.screenserver.Server &
EOF"

adb shell chmod 755 /system/etc/init.d/99screenserver
```

## Part 3: Grant Permissions

### With Device Owner (Automatic)

Permissions are auto-granted when the app runs in Device Owner mode.

### Without Device Owner (Manual)

```bash
# Grant all required permissions via ADB
adb shell pm grant com.androidremote.app android.permission.CAMERA
adb shell pm grant com.androidremote.app android.permission.RECORD_AUDIO
adb shell pm grant com.androidremote.app android.permission.READ_EXTERNAL_STORAGE
adb shell pm grant com.androidremote.app android.permission.WRITE_EXTERNAL_STORAGE
adb shell pm grant com.androidremote.app android.permission.ACCESS_FINE_LOCATION
adb shell pm grant com.androidremote.app android.permission.ACCESS_COARSE_LOCATION
adb shell pm grant com.androidremote.app android.permission.POST_NOTIFICATIONS

# For screen capture (requires user confirmation via UI)
# The app will prompt for MediaProjection permission
```

### Enable Accessibility Service (Required for Input Injection)

```bash
# This cannot be automated - must be done via Settings UI
# Settings > Accessibility > Android Remote > Enable

# Or open accessibility settings directly
adb shell am start -a android.settings.ACCESSIBILITY_SETTINGS
```

## Part 4: Configure Server Connection

### Option A: Via QR Code Enrollment

1. Open the Android Remote app
2. Scan the QR code from the admin dashboard (mdmadmin.footprints.media)
3. The device will auto-configure and enroll

### Option B: Manual Configuration

```bash
# Set server URL via SharedPreferences (requires root or debug build)
adb shell am broadcast \
  -a com.androidremote.CONFIGURE \
  --es server_url "https://proxymdm.footprints.media" \
  -n com.androidremote.app/.admin.ConfigReceiver
```

### Option C: Via Settings Dialog

1. Open the Android Remote app
2. Tap the settings icon (gear)
3. Enter server URL: `https://proxymdm.footprints.media`
4. Save and restart

## Part 5: Verify Installation

```bash
# Check if app is installed
adb shell pm list packages | grep androidremote

# Check if running
adb shell ps | grep androidremote

# View app logs
adb logcat -s AndroidRemote:* CommandPollingService:* DeviceOwnerManager:*

# Check Device Owner status
adb shell dumpsys device_policy | grep -i "device owner"

# Check granted permissions
adb shell dumpsys package com.androidremote.app | grep -A 50 "granted=true"
```

## Quick Reference Commands

```bash
# ===== INSTALLATION =====
adb install -r app-debug.apk                    # Install/update app
adb uninstall com.androidremote.app             # Uninstall app

# ===== DEVICE OWNER =====
adb shell dpm set-device-owner com.androidremote.app/.admin.DeviceOwnerReceiver
adb shell dumpsys device_policy                 # Check DO status

# ===== ROOT COMMANDS =====
adb root                                        # Restart ADB as root
adb remount                                     # Remount /system as writable
adb shell su -c "command"                       # Run as superuser

# ===== APP CONTROL =====
adb shell am start -n com.androidremote.app/.MainActivity   # Start app
adb shell am force-stop com.androidremote.app               # Stop app
adb shell pm clear com.androidremote.app                    # Clear app data

# ===== LOGS =====
adb logcat -c                                   # Clear logs
adb logcat | grep -i androidremote              # Filter logs
adb logcat -s TAG:V                             # Specific tag

# ===== SCREEN SERVER =====
adb shell "CLASSPATH=/data/local/tmp/classes.dex app_process / com.androidremote.screenserver.Server"
adb shell pkill -f screenserver                 # Stop screen server

# ===== DEVICE INFO =====
adb shell getprop ro.build.version.release      # Android version
adb shell getprop ro.product.model              # Device model
adb shell wm size                               # Screen resolution
```

## Troubleshooting

### "Device owner can only be set on a fresh device"

```bash
# Device must be factory reset with no accounts added
# Remove all accounts first:
adb shell pm list users
adb shell pm remove-user <user_id>

# Or factory reset:
adb shell am broadcast -a android.intent.action.FACTORY_RESET
```

### "Not allowed to set the device owner"

```bash
# Check if another app is already device owner
adb shell dumpsys device_policy | grep "Device Owner"

# Check for existing accounts
adb shell dumpsys account | grep -i account
```

### App crashes on start

```bash
# Check crash logs
adb logcat -b crash

# Clear app data and retry
adb shell pm clear com.androidremote.app
```

### Screen server won't start

```bash
# Check if DEX file exists
adb shell ls -la /data/local/tmp/classes.dex

# Check for errors
adb logcat -s screenserver:* app_process:*

# Verify app_process path
adb shell which app_process
```
