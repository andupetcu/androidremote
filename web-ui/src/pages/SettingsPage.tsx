import { useState, useEffect } from 'react';
import { makeStyles, mergeClasses } from '@fluentui/react-components';
import { API_BASE, apiFetch } from '../utils/api';

interface EnrollmentToken {
  id: string;
  token: string;
  createdAt: number;
  expiresAt: number | null;
  maxUses: number | null;
  usedCount: number;
  isActive: boolean;
}

const ADB_INSTRUCTIONS = `# ══════════════════════════════════════════════════
# OPTION A: ADB Install (existing devices with USB access)
# ══════════════════════════════════════════════════
#
# Use this when you have physical USB access to a device
# that is already set up. Requires Developer Options enabled.

# 1. Enable Developer Options on the device:
#    Settings > About Phone > tap "Build Number" 7 times
#    Settings > Developer Options > enable USB Debugging

# 2. Connect via USB and install the APK
adb install -r android-remote.apk

# 3. Set as Device Owner (must be done before any Google account
#    is added — if an account exists, remove it first or factory reset)
adb shell dpm set-device-owner com.androidremote.app/.admin.DeviceOwnerReceiver

# 4. Auto-enroll via ADB (replace TOKEN and SERVER_URL)
adb shell am start -n com.androidremote.app/.MainActivity \\
  -e enrollment_token "YOUR_TOKEN" \\
  -e server_url "https://your-server.com"

# 5. Open Settings > Accessibility and enable "Android Remote Input"
#    (Android security prevents auto-enabling AccessibilityService)

# ══════════════════════════════════════════════════
# OPTION A+ : Rooted Device Install
# ══════════════════════════════════════════════════
#
# On rooted devices the app uses 'su' for:
#   - Input injection (tap, swipe, key events) via shell
#   - Screen server deployment to /data/local/tmp/
#   - Multi-tap commands with parallel shell execution
#
# Root is auto-detected at runtime. No extra setup needed
# beyond having a working su binary (Magisk, SuperSU, etc.).

# 1. Install with root access
adb root
adb install -r android-remote.apk

# 2. (Optional) Set as Device Owner for MDM features
#    Adds: silent app install, device lock/wipe/reboot,
#    auto-grant permissions, kiosk mode. Not required if
#    only using root for remote control.
adb shell dpm set-device-owner com.androidremote.app/.admin.DeviceOwnerReceiver

# 3. Auto-enroll via ADB
adb shell am start -n com.androidremote.app/.MainActivity \\
  -e enrollment_token "YOUR_TOKEN" \\
  -e server_url "https://your-server.com"

# ══════════════════════════════════════════════════
# OPTION B: QR Code Provisioning (new or factory-reset devices)
# ══════════════════════════════════════════════════
#
# Use this for phones/tablets with a camera after a factory reset.
# No ADB, no developer mode, no USB cable needed.
# The device downloads and installs the app automatically
# and sets it as Device Owner — fully zero-touch.
#
# IMPORTANT: QR provisioning gives Device Owner (MDM features:
# silent app install, lock, wipe, kiosk). For REMOTE CONTROL
# you additionally need one of:
#   - Root (best): consent-free screen capture + all input methods
#   - ADB (one-time): deploy screen-server + enable accessibility
#   - Neither: user must enable accessibility manually and approve
#              a screen capture dialog each session
#
# Requirements: Android 7.0+, camera, and the APK must be
# uploaded to this server (Settings > Apps > Upload APK).

# Step 1: Factory reset the device (or use a brand-new device)

# Step 2: At the Android welcome/setup screen ("Hi there"),
#          tap the screen 6 times in the same spot.
#          This opens the built-in QR code scanner.

# Step 3: Scan the provisioning QR code.
#          (Generate one using the "QR Provisioning" section above)

# Step 4: The device will:
#    a) Connect to WiFi (if configured in the QR code)
#    b) Download the APK from your server
#    c) Install it and set it as Device Owner automatically
#    d) Skip remaining setup screens

# Step 5: The app opens automatically.
#          Enter the enrollment token to complete registration.

# Step 6: Enable remote control capability (choose one):
#
#   a) ROOTED DEVICE (best — fully automatic):
#      If the device has Magisk or pre-rooted firmware,
#      the app auto-detects root and handles everything:
#      screen-server deploys to /data/local/tmp/ automatically,
#      input injection uses shell commands via su.
#      Just enable AccessibilityService in Settings (required
#      for pinch/scroll gestures).
#
#   b) ONE-TIME ADB (good — consent-free after setup):
#      Connect via USB or network ADB once after provisioning
#      to deploy the screen-server and enable accessibility:
adb push screen-server.apk /data/local/tmp/screen-server.apk
adb shell settings put secure enabled_accessibility_services \\
  com.androidremote.app/.service.InputInjectionService
#      After this, the app runs consent-free. No further ADB needed.
#
#   c) NO ROOT, NO ADB (limited):
#      User must manually:
#      - Enable AccessibilityService in Settings > Accessibility
#      - Approve screen capture dialog per remote session
#      Input: tap/swipe/pinch/scroll work via accessibility.
#      Keys: only Back/Home/Recents/Notifications/Lock/QuickSettings.
#      Text: works via accessibility setText + clipboard paste.

# ── QR Code JSON format (for reference) ─────────
# {
#   "android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME":
#     "com.androidremote.app/.admin.DeviceOwnerReceiver",
#   "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION":
#     "https://YOUR-SERVER/api/uploads/apks/com.androidremote.app-latest.apk",
#   "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_CHECKSUM":
#     "SHA-256_CHECKSUM_OF_APK",
#   "android.app.extra.PROVISIONING_SKIP_EDUCATION_SCREENS": true,
#   "android.app.extra.PROVISIONING_WIFI_SSID": "YourWiFi",
#   "android.app.extra.PROVISIONING_WIFI_PASSWORD": "YourPassword",
#   "android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED": true,
#   "android.app.extra.PROVISIONING_LOCALE": "en_US",
#   "android.app.extra.PROVISIONING_TIME_ZONE": "UTC"
# }

# ══════════════════════════════════════════════════
# OPTION C: Android Boxes & Media Players (no camera)
# ══════════════════════════════════════════════════
#
# For retail media players, Android TV boxes, kiosks, and
# other devices without a camera. These devices cannot use
# QR provisioning, but most expose ADB over the network
# by default or have USB ports for sideloading.
#
# ADB access is the best path for these devices — it lets
# you set Device Owner, deploy the screen-server, and
# enable AccessibilityService in one session. Many Android
# boxes have ADB over TCP enabled by default (port 5555).

# ── C1: ADB over Network (most common for Android boxes) ──
#
# Most Android TV / media player boxes have ADB over TCP
# enabled by default on port 5555, or it can be toggled in
# Settings > Developer Options > Network debugging.
# No USB cable needed — just know the device's IP address.

# 1. Connect to the box over the network
adb connect 192.168.1.XXX:5555

# 2. Install the APK
adb install -r android-remote.apk

# 3. Set as Device Owner (before any Google account is added)
adb shell dpm set-device-owner com.androidremote.app/.admin.DeviceOwnerReceiver

# 4. Deploy screen-server for consent-free screen capture
adb push screen-server.apk /data/local/tmp/screen-server.apk

# 5. Enable AccessibilityService (no UI navigation needed)
adb shell settings put secure enabled_accessibility_services \\
  com.androidremote.app/.service.InputInjectionService

# 6. Auto-enroll with token
adb shell am start -n com.androidremote.app/.MainActivity \\
  -e enrollment_token "YOUR_TOKEN" \\
  -e server_url "https://your-server.com"

# After these steps, the device has full remote control capability
# without root — screen-server handles capture, accessibility
# handles gestures, and shell commands handle key events.

# ── C2: USB Flash Drive Sideload ──────────────────
#
# For devices with USB ports but no network ADB access.

# 1. Copy the APK to a USB flash drive
# 2. Plug the USB drive into the Android box
# 3. Open the built-in file manager (or install one)
# 4. Navigate to the USB drive and tap the APK to install
#    (may need to enable "Install from unknown sources" first)
# 5. Open the app, enter the server URL and enrollment token
#
# Note: USB sideloading does NOT set Device Owner.
# To get Device Owner after USB install, you still need
# ADB access (network or USB) for the dpm command.
# Without Device Owner, the app can still work but won't
# have silent install, lock, wipe, or kiosk capabilities.

# ── C3: Bulk Provisioning Script (fleet deployment) ──
#
# For deploying to many boxes on the same network, use this
# script. It scans the subnet and fully provisions each box:
# install APK, set Device Owner, deploy screen-server,
# enable accessibility, and enroll — all in one pass.
#
# #!/bin/bash
# TOKEN="YOUR_TOKEN"
# SERVER="https://your-server.com"
# SUBNET="192.168.1"
# APK="android-remote.apk"
# SCREEN_SERVER="screen-server.apk"
# for i in $(seq 1 254); do
#   IP="$SUBNET.$i"
#   if adb connect "$IP:5555" 2>/dev/null | grep -q "connected"; then
#     echo "Provisioning $IP..."
#     S="$IP:5555"
#     adb -s $S install -r "$APK"
#     adb -s $S shell dpm set-device-owner \\
#       com.androidremote.app/.admin.DeviceOwnerReceiver
#     adb -s $S push "$SCREEN_SERVER" /data/local/tmp/screen-server.apk
#     adb -s $S shell settings put secure \\
#       enabled_accessibility_services \\
#       com.androidremote.app/.service.InputInjectionService
#     adb -s $S shell am start -n com.androidremote.app/.MainActivity \\
#       -e enrollment_token "$TOKEN" -e server_url "$SERVER"
#     adb disconnect $S
#     echo "  Done: $IP"
#   fi
# done

# ══════════════════════════════════════════════════
# Quick Reference: Which option to use?
# ══════════════════════════════════════════════════
#
# Phone/tablet with USB cable    → Option A  (ADB Install)
# Rooted device                  → Option A+ (Rooted Install)
# Phone/tablet, factory reset,
#   has camera                   → Option B  (QR Provisioning)
# Android box / media player     → Option C1 (Network ADB)
# Box with USB but no net ADB    → Option C2 (USB Sideload)
# Fleet of Android boxes         → Option C3 (Bulk Script)
#
# ══════════════════════════════════════════════════
# Understanding Privilege Levels
# ══════════════════════════════════════════════════
#
#  Privilege        What it gives you
#  ──────────────── ──────────────────────────────────
#  Device Owner     MDM only: silent app install, lock,
#  (QR/ADB dpm)    wipe, reboot, kiosk, auto-grant
#                   runtime permissions. Does NOT help
#                   with remote control at all.
#
#  Accessibility    Basic remote control: tap, swipe,
#  Service          long press, pinch, scroll. Only 6
#  (user enables)   key events (Back/Home/Recents/etc).
#                   No consent-free screen capture.
#
#  Shell / ADB      Full input injection via "input"
#  (UID 2000)       command (all key codes, text).
#                   Screen-server works if pre-deployed
#                   via "adb push". One-time setup.
#
#  Root (su)        Same as shell, plus: screen-server
#                   auto-deploys from bundled assets,
#                   multi-tap support. Best experience.
#
# For full remote control without root, do a one-time
# ADB session to: deploy screen-server + enable
# AccessibilityService. After that, no ADB needed.
#
# ══════════════════════════════════════════════════
# Notes
# ══════════════════════════════════════════════════
# - Device Owner auto-grants runtime permissions only
#   (camera, storage, notifications) — NOT accessibility
# - Root and Device Owner can be used together for full capability
# - The screen server binary persists across app updates
# - App self-updates via INSTALL_APK preserve Device Owner status
# - For QR provisioning, the APK checksum can be generated with:
#     sha256sum android-remote.apk | awk '{print $1}'
# - AccessibilityService can be enabled via ADB (no UI needed):
#     adb shell settings put secure enabled_accessibility_services \\
#       com.androidremote.app/.service.InputInjectionService
# - Screen-server can be deployed via ADB (no root needed):
#     adb push screen-server.apk /data/local/tmp/screen-server.apk`;

const useStyles = makeStyles({
  root: {
    maxWidth: '800px',
  },
  title: {
    margin: '0 0 2rem',
    fontSize: '1.5rem',
  },
  section: {
    backgroundColor: '#16213e',
    border: '1px solid #0f3460',
    borderRadius: '0.5rem',
    padding: '1.5rem',
    marginBottom: '1.5rem',
  },
  sectionHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '1rem',
  },
  sectionTitle: {
    margin: 0,
    fontSize: '1.125rem',
    fontWeight: '600',
  },
  formGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
    marginBottom: '1rem',
    '& label': {
      fontSize: '0.875rem',
      color: '#888',
    },
  },
  input: {
    backgroundColor: '#1a1a2e',
    border: '1px solid #0f3460',
    borderRadius: '0.375rem',
    padding: '0.5rem 0.75rem',
    fontSize: '0.875rem',
    color: '#e0e0e0',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  },
  saveBtn: {
    backgroundColor: '#e94560',
    color: 'white',
    border: 'none',
    padding: '0.5rem 1rem',
    borderRadius: '0.375rem',
    fontSize: '0.875rem',
    cursor: 'pointer',
    transitionProperty: 'background',
    transitionDuration: '0.2s',
    ':hover': {
      backgroundColor: '#ff6b6b',
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
  },
  successMsg: {
    color: '#22c55e',
    fontSize: '0.8125rem',
    marginTop: '0.5rem',
  },
  errorMsg: {
    color: '#ef4444',
    fontSize: '0.8125rem',
    marginTop: '0.5rem',
  },
  codeBlock: {
    backgroundColor: '#1a1a2e',
    border: '1px solid #0f3460',
    borderRadius: '0.375rem',
    padding: '1rem',
    fontFamily: 'monospace',
    fontSize: '0.8125rem',
    lineHeight: '1.6',
    color: '#e0e0e0',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    overflowX: 'auto',
    margin: 0,
  },
  createBtn: {
    backgroundColor: '#e94560',
    color: 'white',
    border: 'none',
    padding: '0.5rem 1rem',
    borderRadius: '0.375rem',
    fontSize: '0.875rem',
    cursor: 'pointer',
    transitionProperty: 'background',
    transitionDuration: '0.2s',
    ':hover': {
      backgroundColor: '#ff6b6b',
    },
  },
  tokens: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  token: {
    backgroundColor: '#1a1a2e',
    border: '1px solid #0f3460',
    borderRadius: '0.375rem',
    padding: '1rem',
  },
  tokenInactive: {
    opacity: 0.5,
  },
  tokenHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    marginBottom: '0.5rem',
  },
  tokenValue: {
    backgroundColor: '#0f3460',
    padding: '0.375rem 0.75rem',
    borderRadius: '0.25rem',
    fontSize: '0.875rem',
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  copyBtn: {
    backgroundColor: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: '0.25rem',
    fontSize: '1rem',
    opacity: 0.7,
    transitionProperty: 'opacity',
    transitionDuration: '0.2s',
    ':hover': {
      opacity: 1,
    },
  },
  tokenMeta: {
    display: 'flex',
    gap: '1rem',
    fontSize: '0.75rem',
    color: '#888',
    marginBottom: '0.5rem',
  },
  tokenActions: {
    display: 'flex',
    alignItems: 'center',
  },
  revokeBtn: {
    backgroundColor: 'transparent',
    border: '1px solid #ef4444',
    color: '#ef4444',
    padding: '0.25rem 0.75rem',
    borderRadius: '0.25rem',
    fontSize: '0.75rem',
    cursor: 'pointer',
    transitionProperty: 'all',
    transitionDuration: '0.2s',
    ':hover': {
      backgroundColor: 'rgba(239, 68, 68, 0.1)',
    },
  },
  tokenStatus: {
    fontSize: '0.75rem',
    color: '#888',
  },
  info: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  infoRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '0.5rem 0',
    borderBottom: '1px solid #0f3460',
  },
  infoRowLast: {
    borderBottom: 'none',
  },
  infoLabel: {
    color: '#888',
    fontSize: '0.875rem',
  },
  infoValue: {
    fontSize: '0.875rem',
    fontFamily: 'monospace',
  },
  empty: {
    textAlign: 'center',
    padding: '2rem',
    color: '#888',
  },
  loading: {
    textAlign: 'center',
    padding: '2rem',
    color: '#888',
  },
});

export function SettingsPage() {
  const styles = useStyles();

  // Settings state
  const [serverName, setServerName] = useState('');
  const [serverNameMsg, setServerNameMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordMsg, setPasswordMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [appsUpdateTime, setAppsUpdateTime] = useState<number>(3);
  const [appsUpdateTimeMsg, setAppsUpdateTimeMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [copiedAdb, setCopiedAdb] = useState(false);

  // QR provisioning state
  const [qrWifiSsid, setQrWifiSsid] = useState('');
  const [qrWifiPassword, setQrWifiPassword] = useState('');
  const [qrApkUrl, setQrApkUrl] = useState('');
  const [qrApkChecksum, setQrApkChecksum] = useState('');
  const [qrLocale, setQrLocale] = useState('en_US');
  const [qrTimezone, setQrTimezone] = useState('UTC');
  const [qrGenerated, setQrGenerated] = useState(false);
  const [copiedQrJson, setCopiedQrJson] = useState(false);

  // Token state
  const [tokens, setTokens] = useState<EnrollmentToken[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchSettings();
    fetchTokens();
  }, []);

  const fetchSettings = async () => {
    try {
      const res = await apiFetch(`${API_BASE}/api/settings`);
      if (res.ok) {
        const data = await res.json();
        if (data.serverName !== undefined) setServerName(data.serverName);
        if (data.appsUpdateTime !== undefined) setAppsUpdateTime(data.appsUpdateTime);
      }
    } catch (err) {
      console.error('Failed to fetch settings:', err);
    }
  };

  const handleSaveServerName = async () => {
    try {
      const res = await apiFetch(`${API_BASE}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverName }),
      });
      if (res.ok) {
        setServerNameMsg({ type: 'success', text: 'Server name saved.' });
        document.title = serverName || 'Android Remote';
      } else {
        setServerNameMsg({ type: 'error', text: 'Failed to save server name.' });
      }
    } catch {
      setServerNameMsg({ type: 'error', text: 'Failed to save server name.' });
    }
  };

  const handleChangePassword = async () => {
    if (newPassword !== confirmPassword) {
      setPasswordMsg({ type: 'error', text: 'New passwords do not match.' });
      return;
    }
    if (!currentPassword || !newPassword) {
      setPasswordMsg({ type: 'error', text: 'All fields are required.' });
      return;
    }
    try {
      const res = await apiFetch(`${API_BASE}/api/auth/password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (res.ok) {
        setPasswordMsg({ type: 'success', text: 'Password changed successfully.' });
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } else {
        const data = await res.json().catch(() => null);
        setPasswordMsg({ type: 'error', text: data?.error || 'Failed to change password.' });
      }
    } catch {
      setPasswordMsg({ type: 'error', text: 'Failed to change password.' });
    }
  };

  const handleSaveAppsUpdateTime = async () => {
    try {
      const res = await apiFetch(`${API_BASE}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appsUpdateTime }),
      });
      if (res.ok) {
        setAppsUpdateTimeMsg({ type: 'success', text: 'Apps update time saved.' });
      } else {
        setAppsUpdateTimeMsg({ type: 'error', text: 'Failed to save apps update time.' });
      }
    } catch {
      setAppsUpdateTimeMsg({ type: 'error', text: 'Failed to save apps update time.' });
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const handleCopyAdb = () => {
    navigator.clipboard.writeText(ADB_INSTRUCTIONS);
    setCopiedAdb(true);
    setTimeout(() => setCopiedAdb(false), 2000);
  };

  // Pre-fill APK URL from server base
  useEffect(() => {
    if (!qrApkUrl) {
      const base = API_BASE || window.location.origin;
      setQrApkUrl(`${base}/api/uploads/apks/com.androidremote.app-latest.apk`);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const getProvisioningJson = () => {
    const payload: Record<string, unknown> = {
      'android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME':
        'com.androidremote.app/.admin.DeviceOwnerReceiver',
      'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION': qrApkUrl,
      'android.app.extra.PROVISIONING_SKIP_EDUCATION_SCREENS': true,
      'android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED': true,
      'android.app.extra.PROVISIONING_LOCALE': qrLocale,
      'android.app.extra.PROVISIONING_TIME_ZONE': qrTimezone,
    };
    if (qrApkChecksum) {
      payload['android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_CHECKSUM'] = qrApkChecksum;
    }
    if (qrWifiSsid) {
      payload['android.app.extra.PROVISIONING_WIFI_SSID'] = qrWifiSsid;
      if (qrWifiPassword) {
        payload['android.app.extra.PROVISIONING_WIFI_SECURITY_TYPE'] = 'WPA';
        payload['android.app.extra.PROVISIONING_WIFI_PASSWORD'] = qrWifiPassword;
      } else {
        payload['android.app.extra.PROVISIONING_WIFI_SECURITY_TYPE'] = 'NONE';
      }
    }
    return JSON.stringify(payload);
  };

  const getProvisioningQrUrl = () => {
    const json = getProvisioningJson();
    return `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(json)}&size=300x300&ecc=M`;
  };

  const handleGenerateQr = () => {
    setQrGenerated(true);
  };

  const handleCopyQrJson = () => {
    navigator.clipboard.writeText(getProvisioningJson());
    setCopiedQrJson(true);
    setTimeout(() => setCopiedQrJson(false), 2000);
  };

  const fetchTokens = async () => {
    try {
      const res = await apiFetch(`${API_BASE}/api/enroll/tokens`);
      const data = await res.json();
      setTokens(data.tokens || []);
    } catch (err) {
      console.error('Failed to fetch tokens:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateToken = async () => {
    try {
      const res = await apiFetch(`${API_BASE}/api/enroll/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        fetchTokens();
      }
    } catch (err) {
      console.error('Failed to create token:', err);
    }
  };

  const handleRevokeToken = async (tokenId: string) => {
    try {
      await apiFetch(`${API_BASE}/api/enroll/tokens/${tokenId}`, {
        method: 'DELETE',
      });
      fetchTokens();
    } catch (err) {
      console.error('Failed to revoke token:', err);
    }
  };

  return (
    <div className={styles.root}>
      <h1 className={styles.title}>Settings</h1>

      {/* Server Name */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Server Name</h2>
        <div className={styles.formGroup} style={{ marginTop: '1rem' }}>
          <label>Name</label>
          <input
            className={styles.input}
            type="text"
            value={serverName}
            onChange={(e) => { setServerName(e.target.value); setServerNameMsg(null); }}
            placeholder="My Android Remote Server"
          />
        </div>
        <button className={styles.saveBtn} onClick={handleSaveServerName}>Save</button>
        {serverNameMsg && (
          <div className={serverNameMsg.type === 'success' ? styles.successMsg : styles.errorMsg}>
            {serverNameMsg.text}
          </div>
        )}
      </section>

      {/* Change Password */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Change Password</h2>
        <div className={styles.formGroup} style={{ marginTop: '1rem' }}>
          <label>Current Password</label>
          <input
            className={styles.input}
            type="password"
            value={currentPassword}
            onChange={(e) => { setCurrentPassword(e.target.value); setPasswordMsg(null); }}
          />
        </div>
        <div className={styles.formGroup}>
          <label>New Password</label>
          <input
            className={styles.input}
            type="password"
            value={newPassword}
            onChange={(e) => { setNewPassword(e.target.value); setPasswordMsg(null); }}
          />
        </div>
        <div className={styles.formGroup}>
          <label>Confirm New Password</label>
          <input
            className={styles.input}
            type="password"
            value={confirmPassword}
            onChange={(e) => { setConfirmPassword(e.target.value); setPasswordMsg(null); }}
          />
        </div>
        <button className={styles.saveBtn} onClick={handleChangePassword}>Save</button>
        {passwordMsg && (
          <div className={passwordMsg.type === 'success' ? styles.successMsg : styles.errorMsg}>
            {passwordMsg.text}
          </div>
        )}
      </section>

      {/* Apps Update Time */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Apps Update Time</h2>
        <div className={styles.formGroup} style={{ marginTop: '1rem' }}>
          <label>Hour of day (0-23)</label>
          <input
            className={styles.input}
            type="number"
            min={0}
            max={23}
            value={appsUpdateTime}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              if (!isNaN(val) && val >= 0 && val <= 23) setAppsUpdateTime(val);
              setAppsUpdateTimeMsg(null);
            }}
          />
        </div>
        <button className={styles.saveBtn} onClick={handleSaveAppsUpdateTime}>Save</button>
        {appsUpdateTimeMsg && (
          <div className={appsUpdateTimeMsg.type === 'success' ? styles.successMsg : styles.errorMsg}>
            {appsUpdateTimeMsg.text}
          </div>
        )}
      </section>

      {/* QR Provisioning (Factory Reset / New Devices) */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>QR Provisioning (New / Factory-Reset Devices)</h2>
        <p style={{ color: '#888', fontSize: '0.8125rem', margin: '0.75rem 0' }}>
          Generate a QR code for zero-touch Device Owner provisioning on phones and tablets with cameras.
          After a factory reset, tap the welcome screen 6 times to open the QR scanner (Android 7+).
          The device auto-downloads the APK and sets it as Device Owner (MDM features: silent install,
          lock, wipe, kiosk). For full remote control, a one-time ADB session or root is still needed
          to deploy the screen-server. For camera-less devices (Android boxes), see Option C in the guide below.
        </p>

        <div className={styles.formGroup} style={{ marginTop: '1rem' }}>
          <label>APK Download URL *</label>
          <input
            className={styles.input}
            type="text"
            value={qrApkUrl}
            onChange={(e) => { setQrApkUrl(e.target.value); setQrGenerated(false); }}
            placeholder="https://your-server.com/api/uploads/apks/com.androidremote.app-latest.apk"
          />
        </div>
        <div className={styles.formGroup}>
          <label>APK SHA-256 Checksum (optional but recommended)</label>
          <input
            className={styles.input}
            type="text"
            value={qrApkChecksum}
            onChange={(e) => { setQrApkChecksum(e.target.value); setQrGenerated(false); }}
            placeholder="sha256sum android-remote.apk | awk '{print $1}'"
          />
        </div>
        <div style={{ display: 'flex', gap: '1rem' }}>
          <div className={styles.formGroup} style={{ flex: 1 }}>
            <label>WiFi SSID (optional)</label>
            <input
              className={styles.input}
              type="text"
              value={qrWifiSsid}
              onChange={(e) => { setQrWifiSsid(e.target.value); setQrGenerated(false); }}
              placeholder="Network name"
            />
          </div>
          <div className={styles.formGroup} style={{ flex: 1 }}>
            <label>WiFi Password</label>
            <input
              className={styles.input}
              type="password"
              value={qrWifiPassword}
              onChange={(e) => { setQrWifiPassword(e.target.value); setQrGenerated(false); }}
              placeholder="Leave empty for open networks"
            />
          </div>
        </div>
        <div style={{ display: 'flex', gap: '1rem' }}>
          <div className={styles.formGroup} style={{ flex: 1 }}>
            <label>Locale</label>
            <input
              className={styles.input}
              type="text"
              value={qrLocale}
              onChange={(e) => { setQrLocale(e.target.value); setQrGenerated(false); }}
              placeholder="en_US"
            />
          </div>
          <div className={styles.formGroup} style={{ flex: 1 }}>
            <label>Timezone</label>
            <input
              className={styles.input}
              type="text"
              value={qrTimezone}
              onChange={(e) => { setQrTimezone(e.target.value); setQrGenerated(false); }}
              placeholder="UTC"
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            className={styles.saveBtn}
            onClick={handleGenerateQr}
            disabled={!qrApkUrl}
          >
            Generate QR Code
          </button>
          <button
            className={styles.createBtn}
            onClick={handleCopyQrJson}
            disabled={!qrApkUrl}
          >
            {copiedQrJson ? 'Copied!' : 'Copy JSON'}
          </button>
        </div>

        {qrGenerated && qrApkUrl && (
          <div style={{ marginTop: '1.5rem', textAlign: 'center' }}>
            <img
              src={getProvisioningQrUrl()}
              alt="Provisioning QR code"
              style={{ borderRadius: '0.5rem', background: '#fff', padding: '0.5rem' }}
            />
            <p style={{ color: '#888', fontSize: '0.75rem', marginTop: '0.75rem' }}>
              Print this QR code or display it on screen. Scan it during Android setup after factory reset.
            </p>
            <details style={{ marginTop: '0.75rem', textAlign: 'left' }}>
              <summary style={{ cursor: 'pointer', color: '#888', fontSize: '0.8125rem' }}>
                View provisioning JSON
              </summary>
              <pre className={styles.codeBlock} style={{ marginTop: '0.5rem', fontSize: '0.75rem' }}>
                {JSON.stringify(JSON.parse(getProvisioningJson()), null, 2)}
              </pre>
            </details>
          </div>
        )}
      </section>

      {/* Device Onboarding Guide */}
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Device Onboarding Guide (ADB)</h2>
          <button className={styles.createBtn} onClick={handleCopyAdb}>
            {copiedAdb ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <pre className={styles.codeBlock}>{ADB_INSTRUCTIONS}</pre>
      </section>

      {/* Enrollment Tokens */}
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Enrollment Tokens</h2>
          <button className={styles.createBtn} onClick={handleCreateToken}>
            + Create Token
          </button>
        </div>

        {loading ? (
          <div className={styles.loading}>Loading tokens...</div>
        ) : (
          <div className={styles.tokens}>
            {tokens.map((token) => (
              <div key={token.id} className={mergeClasses(styles.token, !token.isActive && styles.tokenInactive)}>
                <div className={styles.tokenHeader}>
                  <code className={styles.tokenValue}>{token.token}</code>
                  <button
                    className={styles.copyBtn}
                    onClick={() => copyToClipboard(token.token)}
                    title="Copy token"
                  >
                    📋
                  </button>
                </div>
                <div className={styles.tokenMeta}>
                  <span>Used: {token.usedCount}{token.maxUses ? `/${token.maxUses}` : ''}</span>
                  <span>Created: {new Date(token.createdAt).toLocaleDateString()}</span>
                  {token.expiresAt && (
                    <span>Expires: {new Date(token.expiresAt).toLocaleDateString()}</span>
                  )}
                </div>
                <div className={styles.tokenActions}>
                  {token.isActive && (
                    <button
                      className={styles.revokeBtn}
                      onClick={() => handleRevokeToken(token.id)}
                    >
                      Revoke
                    </button>
                  )}
                  {!token.isActive && (
                    <span className={styles.tokenStatus}>Revoked</span>
                  )}
                </div>
              </div>
            ))}
            {tokens.length === 0 && (
              <div className={styles.empty}>
                No enrollment tokens. Create one to enroll devices.
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
