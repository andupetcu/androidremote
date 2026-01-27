# MDM Server Updates Plan

**Date:** 2025-01-27
**Status:** Draft
**Author:** Claude Code

## Executive Summary

This document outlines the updates needed to transform the current signaling server into a full-featured Mobile Device Management (MDM) platform. The plan draws inspiration from OpenSTF and Headwind MDM while maintaining our WebRTC-based remote control architecture.

### Current State

| Component | Implementation | Status |
|-----------|---------------|--------|
| Device Registry | SQLite with basic CRUD | ✅ Complete |
| Enrollment | Token-based with expiry | ✅ Complete |
| Command Queue | 6 command types, polling-based | ✅ Complete |
| WebRTC Signaling | WebSocket-based | ✅ Complete |
| Device Telemetry | None | ❌ Missing |
| Policy Management | None | ❌ Missing |
| App Management | Install/Uninstall only | ⚠️ Partial |
| Real-time Events | None | ❌ Missing |
| File Management | None | ❌ Missing |
| Audit Logging | None | ❌ Missing |

### Target Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Web Dashboard                             │
│  (Device list, Remote control, Policy editor, App management)   │
└─────────────────────────────────────────────────────────────────┘
                                │
                    ┌───────────┴───────────┐
                    │                       │
              HTTP REST API           WebSocket
              (Management)            (Real-time)
                    │                       │
┌─────────────────────────────────────────────────────────────────┐
│                        Node.js Server                            │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌────────────┐ │
│  │   Device    │ │   Policy    │ │   Command   │ │   Event    │ │
│  │   Store     │ │   Engine    │ │   Queue     │ │   Bus      │ │
│  └─────────────┘ └─────────────┘ └─────────────┘ └────────────┘ │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌────────────┐ │
│  │  Telemetry  │ │     App     │ │    File     │ │   Audit    │ │
│  │   Store     │ │  Inventory  │ │  Transfer   │ │    Log     │ │
│  └─────────────┘ └─────────────┘ └─────────────┘ └────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                                │
                          SQLite DB
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
   ┌────┴────┐            ┌────┴────┐            ┌────┴────┐
   │ Device  │            │ Device  │            │ Device  │
   │   App   │            │   App   │            │   App   │
   └─────────┘            └─────────┘            └─────────┘
```

---

## Phase 1: Device Telemetry & Monitoring

**Priority:** P0 (Critical)
**Effort:** Medium
**Impact:** High - Core MDM visibility

### Overview

Enable devices to report their state (battery, network, storage, etc.) to the server. This is fundamental for any MDM dashboard.

### Data Models

#### DeviceTelemetry

```typescript
interface DeviceTelemetry {
  deviceId: string;

  // Battery
  batteryLevel: number;        // 0-100
  batteryCharging: boolean;
  batteryHealth: 'good' | 'overheat' | 'dead' | 'unknown';

  // Network
  networkType: 'wifi' | 'mobile' | 'ethernet' | 'none';
  networkSsid?: string;        // WiFi SSID if connected
  ipAddress?: string;          // Current IP
  signalStrength?: number;     // -100 to 0 dBm

  // Storage
  storageUsedBytes: number;
  storageTotalBytes: number;

  // Memory
  memoryUsedBytes: number;
  memoryTotalBytes: number;

  // Display
  screenOn: boolean;
  brightness: number;          // 0-255

  // Location (optional, if permitted)
  latitude?: number;
  longitude?: number;
  locationAccuracy?: number;

  // System
  uptimeMs: number;
  androidSecurityPatch?: string;

  updatedAt: number;
}
```

#### DeviceInfo (Extended)

Extend the existing Device model:

```typescript
interface Device {
  // Existing fields
  id: string;
  name: string;
  model: string | null;
  androidVersion: string | null;
  enrolledAt: number;
  lastSeenAt: number | null;
  status: 'online' | 'offline';
  publicKey: string | null;

  // New fields
  manufacturer?: string;
  serialNumber?: string;
  imei?: string;
  phoneNumber?: string;
  buildFingerprint?: string;
  kernelVersion?: string;
  displayResolution?: string;
  cpuArchitecture?: string;
  totalRam?: number;
  groupId?: string;           // Device group membership
  policyId?: string;          // Direct policy assignment
  complianceStatus?: 'compliant' | 'non_compliant' | 'pending';
}
```

### Database Schema

```sql
-- Extend devices table
ALTER TABLE devices ADD COLUMN manufacturer TEXT;
ALTER TABLE devices ADD COLUMN serial_number TEXT;
ALTER TABLE devices ADD COLUMN imei TEXT;
ALTER TABLE devices ADD COLUMN phone_number TEXT;
ALTER TABLE devices ADD COLUMN build_fingerprint TEXT;
ALTER TABLE devices ADD COLUMN kernel_version TEXT;
ALTER TABLE devices ADD COLUMN display_resolution TEXT;
ALTER TABLE devices ADD COLUMN cpu_architecture TEXT;
ALTER TABLE devices ADD COLUMN total_ram INTEGER;
ALTER TABLE devices ADD COLUMN group_id TEXT REFERENCES device_groups(id) ON DELETE SET NULL;
ALTER TABLE devices ADD COLUMN policy_id TEXT REFERENCES policies(id) ON DELETE SET NULL;
ALTER TABLE devices ADD COLUMN compliance_status TEXT DEFAULT 'pending'
  CHECK(compliance_status IN ('compliant', 'non_compliant', 'pending'));

-- Device telemetry (latest snapshot per device)
CREATE TABLE device_telemetry (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,

  -- Battery
  battery_level INTEGER,
  battery_charging INTEGER,
  battery_health TEXT,

  -- Network
  network_type TEXT,
  network_ssid TEXT,
  ip_address TEXT,
  signal_strength INTEGER,

  -- Storage
  storage_used_bytes INTEGER,
  storage_total_bytes INTEGER,

  -- Memory
  memory_used_bytes INTEGER,
  memory_total_bytes INTEGER,

  -- Display
  screen_on INTEGER,
  brightness INTEGER,

  -- Location
  latitude REAL,
  longitude REAL,
  location_accuracy REAL,

  -- System
  uptime_ms INTEGER,
  android_security_patch TEXT,

  updated_at INTEGER NOT NULL
);

-- Telemetry history (for trends/alerts)
CREATE TABLE telemetry_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  battery_level INTEGER,
  network_type TEXT,
  storage_used_bytes INTEGER,
  memory_used_bytes INTEGER,
  recorded_at INTEGER NOT NULL
);

CREATE INDEX idx_telemetry_history_device ON telemetry_history(device_id, recorded_at DESC);

-- Keep last 7 days of history per device
-- Clean up via scheduled job
```

### API Endpoints

#### POST /api/devices/:id/telemetry

Device pushes telemetry update.

**Request:**
```json
{
  "batteryLevel": 85,
  "batteryCharging": true,
  "batteryHealth": "good",
  "networkType": "wifi",
  "networkSsid": "OfficeWiFi",
  "ipAddress": "192.168.1.105",
  "storageUsedBytes": 12884901888,
  "storageTotalBytes": 64424509440,
  "memoryUsedBytes": 2147483648,
  "memoryTotalBytes": 4294967296,
  "screenOn": true,
  "brightness": 128,
  "uptimeMs": 86400000
}
```

**Response:** `200 OK`
```json
{
  "success": true,
  "nextReportIn": 60000
}
```

The `nextReportIn` field tells the device when to send the next update (allows server to control polling frequency).

#### GET /api/devices/:id/telemetry

Get latest telemetry for a device.

**Response:**
```json
{
  "deviceId": "dev-abc123",
  "batteryLevel": 85,
  "batteryCharging": true,
  "networkType": "wifi",
  "networkSsid": "OfficeWiFi",
  "ipAddress": "192.168.1.105",
  "storageUsedBytes": 12884901888,
  "storageTotalBytes": 64424509440,
  "storageUsedPercent": 20,
  "memoryUsedBytes": 2147483648,
  "memoryTotalBytes": 4294967296,
  "memoryUsedPercent": 50,
  "screenOn": true,
  "updatedAt": 1706367600000,
  "staleAfter": 120000
}
```

#### GET /api/devices/:id/telemetry/history

Get telemetry history for charts/trends.

**Query params:**
- `from`: Start timestamp (default: 24h ago)
- `to`: End timestamp (default: now)
- `interval`: Aggregation interval in ms (default: 3600000 = 1h)

**Response:**
```json
{
  "deviceId": "dev-abc123",
  "from": 1706281200000,
  "to": 1706367600000,
  "dataPoints": [
    {
      "timestamp": 1706284800000,
      "batteryLevel": 90,
      "networkType": "wifi",
      "storageUsedPercent": 19
    },
    {
      "timestamp": 1706288400000,
      "batteryLevel": 85,
      "networkType": "wifi",
      "storageUsedPercent": 20
    }
  ]
}
```

### Server Implementation

#### New Store: telemetryStore.ts

```typescript
// server/src/services/telemetryStore.ts

export interface TelemetryInput {
  deviceId: string;
  batteryLevel?: number;
  batteryCharging?: boolean;
  batteryHealth?: string;
  networkType?: string;
  networkSsid?: string;
  ipAddress?: string;
  signalStrength?: number;
  storageUsedBytes?: number;
  storageTotalBytes?: number;
  memoryUsedBytes?: number;
  memoryTotalBytes?: number;
  screenOn?: boolean;
  brightness?: number;
  latitude?: number;
  longitude?: number;
  locationAccuracy?: number;
  uptimeMs?: number;
  androidSecurityPatch?: string;
}

class TelemetryStore {
  /**
   * Update device telemetry (upsert)
   */
  updateTelemetry(input: TelemetryInput): void;

  /**
   * Get latest telemetry for a device
   */
  getTelemetry(deviceId: string): DeviceTelemetry | null;

  /**
   * Get telemetry for multiple devices
   */
  getBulkTelemetry(deviceIds: string[]): Map<string, DeviceTelemetry>;

  /**
   * Record telemetry snapshot to history
   */
  recordHistory(deviceId: string): void;

  /**
   * Get telemetry history
   */
  getHistory(deviceId: string, from: number, to: number): TelemetryDataPoint[];

  /**
   * Clean up old history records
   */
  purgeOldHistory(olderThanMs: number): number;
}
```

### Android App Changes

#### New Component: TelemetryReporter

```kotlin
// app/src/main/kotlin/com/androidremote/app/telemetry/TelemetryReporter.kt

class TelemetryReporter(
    private val context: Context,
    private val serverUrl: String,
    private val deviceId: String,
    private val scope: CoroutineScope
) {
    private var reportIntervalMs = 60_000L  // Default 1 minute

    fun start() {
        scope.launch {
            while (isActive) {
                try {
                    val telemetry = collectTelemetry()
                    val response = sendTelemetry(telemetry)
                    reportIntervalMs = response.nextReportIn
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to report telemetry", e)
                }
                delay(reportIntervalMs)
            }
        }
    }

    private fun collectTelemetry(): TelemetryData {
        return TelemetryData(
            batteryLevel = getBatteryLevel(),
            batteryCharging = isBatteryCharging(),
            networkType = getNetworkType(),
            networkSsid = getWifiSsid(),
            ipAddress = getIpAddress(),
            storageUsedBytes = getStorageUsed(),
            storageTotalBytes = getStorageTotal(),
            memoryUsedBytes = getMemoryUsed(),
            memoryTotalBytes = getMemoryTotal(),
            screenOn = isScreenOn(),
            uptimeMs = SystemClock.elapsedRealtime()
        )
    }
}
```

---

## Phase 2: Application Inventory

**Priority:** P0 (Critical)
**Effort:** Medium
**Impact:** High - App management foundation

### Overview

Track installed applications on each device. This enables app management features like whitelist/blacklist, forced updates, and compliance checks.

### Data Models

```typescript
interface InstalledApp {
  deviceId: string;
  packageName: string;
  appName: string;
  versionName: string;
  versionCode: number;
  installedAt: number;
  updatedAt: number;
  isSystemApp: boolean;
  enabled: boolean;
  size: number;           // APK size in bytes
  dataSize?: number;      // App data size
  permissions?: string[]; // Requested permissions
}

interface AppInventoryReport {
  deviceId: string;
  apps: InstalledApp[];
  reportedAt: number;
}
```

### Database Schema

```sql
CREATE TABLE device_apps (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  package_name TEXT NOT NULL,
  app_name TEXT,
  version_name TEXT,
  version_code INTEGER,
  installed_at INTEGER,
  updated_at INTEGER,
  is_system_app INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1,
  size_bytes INTEGER,
  data_size_bytes INTEGER,
  permissions TEXT,  -- JSON array
  PRIMARY KEY (device_id, package_name)
);

CREATE INDEX idx_device_apps_package ON device_apps(package_name);

-- App catalog (known apps across fleet)
CREATE TABLE app_catalog (
  package_name TEXT PRIMARY KEY,
  app_name TEXT,
  latest_version_name TEXT,
  latest_version_code INTEGER,
  category TEXT,
  is_approved INTEGER DEFAULT 0,
  is_blocked INTEGER DEFAULT 0,
  notes TEXT,
  updated_at INTEGER
);
```

### API Endpoints

#### POST /api/devices/:id/apps

Device reports full app inventory (periodic sync).

**Request:**
```json
{
  "apps": [
    {
      "packageName": "com.example.app",
      "appName": "Example App",
      "versionName": "1.2.3",
      "versionCode": 123,
      "isSystemApp": false,
      "enabled": true,
      "sizeBytes": 15728640
    }
  ]
}
```

#### GET /api/devices/:id/apps

Get installed apps for a device.

**Query params:**
- `systemApps`: Include system apps (default: false)
- `search`: Search by app name or package

#### GET /api/apps

Get app catalog (all known apps across fleet).

**Query params:**
- `approved`: Filter by approval status
- `blocked`: Filter by blocked status
- `search`: Search query

#### PUT /api/apps/:packageName

Update app catalog entry (approve/block).

**Request:**
```json
{
  "isApproved": true,
  "isBlocked": false,
  "notes": "Approved for business use"
}
```

---

## Phase 3: Policy & Configuration Management

**Priority:** P1 (High)
**Effort:** High
**Impact:** High - Enterprise MDM features

### Overview

Implement group-based policy management. Policies define device restrictions, app rules, and security requirements.

### Data Models

#### DeviceGroup

```typescript
interface DeviceGroup {
  id: string;
  name: string;
  description?: string;
  policyId?: string;        // Default policy for group
  parentGroupId?: string;   // For nested groups
  deviceCount: number;
  createdAt: number;
  updatedAt: number;
}
```

#### Policy

```typescript
interface Policy {
  id: string;
  name: string;
  description?: string;
  priority: number;         // Higher = takes precedence

  // Kiosk mode
  kioskMode: boolean;
  kioskPackage?: string;    // Single app to run
  kioskExitPassword?: string;

  // App restrictions
  appWhitelist?: string[];  // Only these apps allowed (if set)
  appBlacklist?: string[];  // These apps blocked
  allowUnknownSources: boolean;
  allowPlayStore: boolean;

  // Security
  passwordRequired: boolean;
  passwordMinLength?: number;
  passwordRequireNumeric?: boolean;
  passwordRequireSymbol?: boolean;
  maxPasswordAge?: number;  // Days before password expires
  maxFailedAttempts?: number;
  lockAfterInactivity?: number; // Seconds
  encryptionRequired: boolean;

  // Hardware
  cameraEnabled: boolean;
  microphoneEnabled: boolean;
  bluetoothEnabled: boolean;
  wifiEnabled: boolean;
  nfcEnabled: boolean;
  usbEnabled: boolean;
  sdCardEnabled: boolean;

  // Network
  vpnRequired: boolean;
  vpnPackage?: string;
  allowedWifiSsids?: string[];

  // Development
  adbEnabled: boolean;
  developerOptionsEnabled: boolean;

  // System
  allowFactoryReset: boolean;
  allowOtaUpdates: boolean;
  allowDateTimeChange: boolean;

  createdAt: number;
  updatedAt: number;
}
```

### Database Schema

```sql
-- Device groups
CREATE TABLE device_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  policy_id TEXT REFERENCES policies(id) ON DELETE SET NULL,
  parent_group_id TEXT REFERENCES device_groups(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Group membership
CREATE TABLE device_group_members (
  group_id TEXT NOT NULL REFERENCES device_groups(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, device_id)
);

CREATE INDEX idx_group_members_device ON device_group_members(device_id);

-- Policies
CREATE TABLE policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  priority INTEGER DEFAULT 0,

  -- Kiosk
  kiosk_mode INTEGER DEFAULT 0,
  kiosk_package TEXT,
  kiosk_exit_password TEXT,

  -- Apps
  app_whitelist TEXT,  -- JSON array
  app_blacklist TEXT,  -- JSON array
  allow_unknown_sources INTEGER DEFAULT 0,
  allow_play_store INTEGER DEFAULT 1,

  -- Security
  password_required INTEGER DEFAULT 0,
  password_min_length INTEGER,
  password_require_numeric INTEGER DEFAULT 0,
  password_require_symbol INTEGER DEFAULT 0,
  max_password_age INTEGER,
  max_failed_attempts INTEGER,
  lock_after_inactivity INTEGER,
  encryption_required INTEGER DEFAULT 0,

  -- Hardware
  camera_enabled INTEGER DEFAULT 1,
  microphone_enabled INTEGER DEFAULT 1,
  bluetooth_enabled INTEGER DEFAULT 1,
  wifi_enabled INTEGER DEFAULT 1,
  nfc_enabled INTEGER DEFAULT 1,
  usb_enabled INTEGER DEFAULT 1,
  sd_card_enabled INTEGER DEFAULT 1,

  -- Network
  vpn_required INTEGER DEFAULT 0,
  vpn_package TEXT,
  allowed_wifi_ssids TEXT,  -- JSON array

  -- Development
  adb_enabled INTEGER DEFAULT 0,
  developer_options_enabled INTEGER DEFAULT 0,

  -- System
  allow_factory_reset INTEGER DEFAULT 1,
  allow_ota_updates INTEGER DEFAULT 1,
  allow_date_time_change INTEGER DEFAULT 1,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### API Endpoints

#### Groups

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/groups` | List all groups |
| POST | `/api/groups` | Create group |
| GET | `/api/groups/:id` | Get group details |
| PUT | `/api/groups/:id` | Update group |
| DELETE | `/api/groups/:id` | Delete group |
| GET | `/api/groups/:id/devices` | List devices in group |
| POST | `/api/groups/:id/devices` | Add devices to group |
| DELETE | `/api/groups/:id/devices/:deviceId` | Remove device from group |

#### Policies

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/policies` | List all policies |
| POST | `/api/policies` | Create policy |
| GET | `/api/policies/:id` | Get policy details |
| PUT | `/api/policies/:id` | Update policy |
| DELETE | `/api/policies/:id` | Delete policy |
| GET | `/api/devices/:id/policy` | Get effective policy for device |
| POST | `/api/devices/:id/policy/sync` | Push policy to device |

### Policy Resolution

When a device belongs to multiple groups or has a direct policy assignment:

1. Direct device policy (highest priority)
2. Group policy (by priority, then alphabetically)
3. Parent group policy (recursive)
4. Default policy

```typescript
function getEffectivePolicy(deviceId: string): Policy {
  // Check direct assignment
  const device = deviceStore.getDevice(deviceId);
  if (device.policyId) {
    return policyStore.getPolicy(device.policyId);
  }

  // Check group assignments (sorted by priority)
  const groups = groupStore.getDeviceGroups(deviceId);
  for (const group of groups.sort((a, b) => b.priority - a.priority)) {
    if (group.policyId) {
      return policyStore.getPolicy(group.policyId);
    }
    // Check parent groups
    let parent = group.parentGroupId;
    while (parent) {
      const parentGroup = groupStore.getGroup(parent);
      if (parentGroup?.policyId) {
        return policyStore.getPolicy(parentGroup.policyId);
      }
      parent = parentGroup?.parentGroupId;
    }
  }

  // Return default policy
  return policyStore.getDefaultPolicy();
}
```

---

## Phase 4: Enhanced Command Types

**Priority:** P0 (Critical)
**Effort:** Low
**Impact:** High - Essential device control

### New Command Types

```typescript
type CommandType =
  // === Existing ===
  | 'INSTALL_APK'      // Install app from URL
  | 'UNINSTALL_APP'    // Uninstall app
  | 'LOCK'             // Lock device
  | 'REBOOT'           // Reboot device
  | 'WIPE'             // Factory reset
  | 'START_REMOTE'     // Start remote session

  // === App Management ===
  | 'UPDATE_APP'       // Update app to specific version
  | 'CLEAR_APP_DATA'   // Clear app data and cache
  | 'CLEAR_APP_CACHE'  // Clear only cache
  | 'ENABLE_APP'       // Enable disabled app
  | 'DISABLE_APP'      // Disable app (hide from launcher)
  | 'SET_DEFAULT_APP'  // Set as default for intent
  | 'LAUNCH_APP'       // Launch app
  | 'STOP_APP'         // Force stop app

  // === Device Control ===
  | 'UNLOCK'           // Unlock device (if managed)
  | 'SET_VOLUME'       // Set volume level
  | 'SET_BRIGHTNESS'   // Set screen brightness
  | 'TAKE_SCREENSHOT'  // Capture and upload screenshot
  | 'SCREEN_ON'        // Turn screen on
  | 'SCREEN_OFF'       // Turn screen off

  // === Security ===
  | 'LOST_MODE'        // Enable lost mode
  | 'EXIT_LOST_MODE'   // Disable lost mode
  | 'SET_PASSWORD'     // Set device password
  | 'CLEAR_PASSWORD'   // Remove device password
  | 'ENCRYPT_DEVICE'   // Start device encryption

  // === Policy ===
  | 'SYNC_POLICY'      // Push policy update
  | 'CHECK_COMPLIANCE' // Run compliance check

  // === Telemetry ===
  | 'REFRESH_TELEMETRY' // Request immediate telemetry
  | 'GET_LOCATION'      // Request current location
  | 'SYNC_APPS'         // Request app inventory sync

  // === Files ===
  | 'LIST_FILES'       // List directory contents
  | 'DOWNLOAD_FILE'    // Pull file from device
  | 'UPLOAD_FILE'      // Push file to device
  | 'DELETE_FILE'      // Delete file

  // === Shell ===
  | 'RUN_SHELL'        // Execute shell command (if permitted)

  // === Messaging ===
  | 'SEND_MESSAGE'     // Show notification/message on device
  | 'PLAY_SOUND'       // Play sound (for locating device)
```

### Payload Schemas

```typescript
// App commands
interface UpdateAppPayload {
  packageName: string;
  url: string;
  versionCode?: number;
}

interface ClearAppDataPayload {
  packageName: string;
  clearCache: boolean;
  clearData: boolean;
}

interface LaunchAppPayload {
  packageName: string;
  action?: string;    // Intent action
  extras?: Record<string, string>;
}

// Device commands
interface SetVolumePayload {
  stream: 'media' | 'ring' | 'notification' | 'alarm' | 'system';
  level: number;  // 0-100
}

interface SetBrightnessPayload {
  level: number;  // 0-255
  auto: boolean;
}

// Security commands
interface LostModePayload {
  message: string;
  phoneNumber?: string;
  footnote?: string;
}

interface SetPasswordPayload {
  password: string;
  requireChange: boolean;
}

// File commands
interface ListFilesPayload {
  path: string;
  recursive?: boolean;
}

interface DownloadFilePayload {
  path: string;
  uploadUrl: string;  // Where to upload the file
}

interface UploadFilePayload {
  downloadUrl: string;  // Where to download from
  destinationPath: string;
}

// Message commands
interface SendMessagePayload {
  title: string;
  body: string;
  priority: 'low' | 'normal' | 'high';
  persistent: boolean;  // Stay until dismissed
}

interface PlaySoundPayload {
  duration: number;  // Seconds
  volume: number;    // 0-100
}
```

### Update Database Constraint

```sql
-- Update command type constraint
ALTER TABLE device_commands DROP CONSTRAINT IF EXISTS device_commands_type_check;

ALTER TABLE device_commands ADD CONSTRAINT device_commands_type_check
CHECK(type IN (
  'INSTALL_APK', 'UNINSTALL_APP', 'LOCK', 'REBOOT', 'WIPE', 'START_REMOTE',
  'UPDATE_APP', 'CLEAR_APP_DATA', 'CLEAR_APP_CACHE', 'ENABLE_APP', 'DISABLE_APP',
  'SET_DEFAULT_APP', 'LAUNCH_APP', 'STOP_APP',
  'UNLOCK', 'SET_VOLUME', 'SET_BRIGHTNESS', 'TAKE_SCREENSHOT', 'SCREEN_ON', 'SCREEN_OFF',
  'LOST_MODE', 'EXIT_LOST_MODE', 'SET_PASSWORD', 'CLEAR_PASSWORD', 'ENCRYPT_DEVICE',
  'SYNC_POLICY', 'CHECK_COMPLIANCE',
  'REFRESH_TELEMETRY', 'GET_LOCATION', 'SYNC_APPS',
  'LIST_FILES', 'DOWNLOAD_FILE', 'UPLOAD_FILE', 'DELETE_FILE',
  'RUN_SHELL',
  'SEND_MESSAGE', 'PLAY_SOUND'
));
```

---

## Phase 5: Real-time Events

**Priority:** P1 (High)
**Effort:** Medium
**Impact:** High - UX improvement

### Overview

Extend WebSocket support for real-time device events and admin notifications, beyond just WebRTC signaling.

### Event Types

```typescript
type DeviceEventType =
  // Connection
  | 'device-online'
  | 'device-offline'

  // Telemetry
  | 'battery-low'           // Battery < 20%
  | 'battery-critical'      // Battery < 5%
  | 'storage-low'           // Storage < 10%
  | 'connectivity-changed'  // Network change

  // Apps
  | 'app-installed'
  | 'app-uninstalled'
  | 'app-updated'

  // Commands
  | 'command-completed'
  | 'command-failed'

  // Security
  | 'policy-violation'
  | 'tampering-detected'
  | 'unauthorized-factory-reset'

  // System
  | 'boot-completed'
  | 'shutdown-initiated';

interface DeviceEvent {
  type: 'device-event';
  eventType: DeviceEventType;
  deviceId: string;
  deviceName: string;
  data: Record<string, unknown>;
  timestamp: number;
  severity: 'info' | 'warning' | 'critical';
}
```

### WebSocket Protocol

#### Admin Connection

New WebSocket path: `/ws/admin`

```typescript
// Admin subscribes to events
interface AdminSubscribe {
  type: 'subscribe';
  deviceIds?: string[];      // If empty, all devices
  eventTypes?: string[];     // If empty, all events
  groupIds?: string[];       // Subscribe to group devices
}

// Admin receives events
interface AdminEventMessage {
  type: 'device-event';
  event: DeviceEvent;
}

// Admin can send commands via WebSocket
interface AdminCommand {
  type: 'command';
  deviceId: string;
  command: CommandType;
  payload?: Record<string, unknown>;
}

// Command response
interface AdminCommandResponse {
  type: 'command-queued';
  commandId: string;
  deviceId: string;
}
```

### Server Implementation

#### Enhanced signaling.ts

```typescript
// Add admin WebSocket handling

interface AdminConnection {
  ws: WebSocket;
  subscribedDevices: Set<string>;  // Empty = all
  subscribedEvents: Set<string>;   // Empty = all
  subscribedGroups: Set<string>;
}

const adminConnections = new Map<string, AdminConnection>();

// Event bus for device events
class EventBus {
  private subscribers: ((event: DeviceEvent) => void)[] = [];

  subscribe(callback: (event: DeviceEvent) => void): () => void {
    this.subscribers.push(callback);
    return () => {
      this.subscribers = this.subscribers.filter(s => s !== callback);
    };
  }

  emit(event: DeviceEvent): void {
    this.subscribers.forEach(callback => callback(event));

    // Also store in database for history
    eventStore.recordEvent(event);

    // Broadcast to subscribed admins
    for (const [, admin] of adminConnections) {
      if (this.shouldReceive(admin, event)) {
        send(admin.ws, { type: 'device-event', event });
      }
    }
  }

  private shouldReceive(admin: AdminConnection, event: DeviceEvent): boolean {
    // Check device filter
    if (admin.subscribedDevices.size > 0 &&
        !admin.subscribedDevices.has(event.deviceId)) {
      return false;
    }

    // Check event type filter
    if (admin.subscribedEvents.size > 0 &&
        !admin.subscribedEvents.has(event.eventType)) {
      return false;
    }

    return true;
  }
}

export const eventBus = new EventBus();
```

### Event Storage

```sql
CREATE TABLE device_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('info', 'warning', 'critical')),
  data TEXT,  -- JSON
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_device_events_device ON device_events(device_id, created_at DESC);
CREATE INDEX idx_device_events_type ON device_events(event_type, created_at DESC);
CREATE INDEX idx_device_events_severity ON device_events(severity, created_at DESC)
  WHERE severity IN ('warning', 'critical');
```

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/events` | List recent events (all devices) |
| GET | `/api/devices/:id/events` | List events for device |
| GET | `/api/events/unread` | Get unread critical events |
| POST | `/api/events/:id/acknowledge` | Acknowledge event |

---

## Phase 6: File Management

**Priority:** P2 (Medium)
**Effort:** Medium
**Impact:** Medium - Nice to have

### Overview

Enable file browsing, upload, and download between server and device.

### File Transfer Flow

```
Upload to device:
1. Admin uploads file to server (multipart)
2. Server stores file, returns URL
3. Server queues UPLOAD_FILE command with URL
4. Device downloads from server URL
5. Device saves to destination path
6. Device acknowledges completion

Download from device:
1. Admin requests file download
2. Server queues DOWNLOAD_FILE command
3. Device reads file, uploads to server URL
4. Server notifies admin file is ready
5. Admin downloads from server
```

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/devices/:id/files?path=` | List directory |
| POST | `/api/devices/:id/files/download` | Request file download |
| POST | `/api/devices/:id/files/upload` | Upload file to device |
| DELETE | `/api/devices/:id/files?path=` | Delete file |
| GET | `/api/files/:jobId` | Get transfer job status |
| GET | `/api/files/:jobId/download` | Download completed file |

### Database Schema

```sql
CREATE TABLE file_transfers (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK(direction IN ('upload', 'download')),
  device_path TEXT NOT NULL,
  server_path TEXT,
  file_size INTEGER,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'transferring', 'completed', 'failed')),
  progress INTEGER DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
```

---

## Phase 7: Audit Logging

**Priority:** P2 (Medium)
**Effort:** Low
**Impact:** Medium - Compliance

### Overview

Log all administrative actions and significant device events for audit trail.

### Audit Events

```typescript
type AuditAction =
  // Device management
  | 'device.enrolled'
  | 'device.unenrolled'
  | 'device.renamed'
  | 'device.group_changed'

  // Commands
  | 'command.queued'
  | 'command.completed'
  | 'command.failed'
  | 'command.cancelled'

  // Policies
  | 'policy.created'
  | 'policy.updated'
  | 'policy.deleted'
  | 'policy.assigned'

  // Groups
  | 'group.created'
  | 'group.updated'
  | 'group.deleted'

  // Apps
  | 'app.approved'
  | 'app.blocked'

  // Admin
  | 'admin.login'
  | 'admin.logout'
  | 'token.created'
  | 'token.revoked';

interface AuditLog {
  id: string;
  timestamp: number;
  actorType: 'admin' | 'device' | 'system';
  actorId?: string;
  action: AuditAction;
  resourceType: 'device' | 'policy' | 'group' | 'command' | 'app' | 'token';
  resourceId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
}
```

### Database Schema

```sql
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('admin', 'device', 'system')),
  actor_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  details TEXT,  -- JSON
  ip_address TEXT
);

CREATE INDEX idx_audit_logs_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX idx_audit_logs_actor ON audit_logs(actor_type, actor_id);
CREATE INDEX idx_audit_logs_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
```

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/audit` | List audit logs |
| GET | `/api/audit/export` | Export logs as CSV |

**Query params for listing:**
- `from`, `to`: Timestamp range
- `actorType`: Filter by actor
- `action`: Filter by action
- `resourceType`, `resourceId`: Filter by resource
- `limit`, `offset`: Pagination

---

## Implementation Roadmap

### Sprint 1 (Week 1-2): Foundation

- [ ] Phase 1: Device Telemetry
  - [ ] Database schema migration
  - [ ] TelemetryStore implementation
  - [ ] API endpoints
  - [ ] Android TelemetryReporter

- [ ] Phase 4: Enhanced Commands (partial)
  - [ ] Add new command types to schema
  - [ ] Update commandStore validation
  - [ ] Document payload schemas

### Sprint 2 (Week 3-4): App Management

- [ ] Phase 2: Application Inventory
  - [ ] Database schema
  - [ ] AppInventoryStore implementation
  - [ ] API endpoints
  - [ ] Android AppReporter
  - [ ] App catalog management

### Sprint 3 (Week 5-6): Policies

- [ ] Phase 3: Policy Management
  - [ ] Database schema
  - [ ] PolicyStore, GroupStore implementation
  - [ ] Policy resolution logic
  - [ ] API endpoints
  - [ ] Android PolicyEnforcer

### Sprint 4 (Week 7-8): Real-time & Polish

- [ ] Phase 5: Real-time Events
  - [ ] EventBus implementation
  - [ ] Admin WebSocket endpoint
  - [ ] Event storage
  - [ ] Android event reporting

- [ ] Phase 7: Audit Logging
  - [ ] AuditStore implementation
  - [ ] Middleware integration
  - [ ] API endpoints

### Sprint 5 (Week 9-10): Files & Advanced

- [ ] Phase 6: File Management
  - [ ] File transfer service
  - [ ] Storage management
  - [ ] API endpoints
  - [ ] Android file handler

- [ ] Phase 4: Remaining Commands
  - [ ] Android handlers for all command types
  - [ ] Testing and validation

---

## Android App Changes Summary

| Component | Phase | Description |
|-----------|-------|-------------|
| TelemetryReporter | 1 | Periodic telemetry collection and push |
| AppReporter | 2 | App inventory sync |
| PolicyEnforcer | 3 | Apply and monitor policy compliance |
| EventReporter | 5 | Real-time event reporting |
| FileHandler | 6 | File upload/download handling |
| CommandHandlers | 4 | Handlers for all new command types |

### New Android Modules

```
app/src/main/kotlin/com/androidremote/app/
├── telemetry/
│   ├── TelemetryReporter.kt
│   ├── TelemetryCollector.kt
│   └── BatteryMonitor.kt
├── apps/
│   ├── AppReporter.kt
│   └── AppChangeReceiver.kt
├── policy/
│   ├── PolicyEnforcer.kt
│   ├── PolicyStore.kt
│   ├── KioskManager.kt
│   └── ComplianceChecker.kt
├── events/
│   ├── EventReporter.kt
│   └── EventTypes.kt
├── files/
│   ├── FileHandler.kt
│   └── FileTransferService.kt
└── commands/
    ├── CommandDispatcher.kt
    └── handlers/
        ├── AppCommandHandler.kt
        ├── DeviceCommandHandler.kt
        ├── SecurityCommandHandler.kt
        └── FileCommandHandler.kt
```

---

## Testing Strategy

### Server Tests

```typescript
// New test files needed
server/test/
├── telemetry.test.ts
├── apps.test.ts
├── groups.test.ts
├── policies.test.ts
├── events.test.ts
├── files.test.ts
└── audit.test.ts
```

### Integration Tests

- Device enrollment → telemetry reporting → policy assignment flow
- Command queue → device execution → acknowledgment flow
- File transfer round-trip
- WebSocket event broadcasting

### Load Tests

- 100 devices reporting telemetry simultaneously
- 1000 commands queued in rapid succession
- Admin dashboard with 50 concurrent connections

---

## Security Considerations

1. **API Authentication** (not yet implemented)
   - JWT tokens for admin API
   - Device tokens for device API
   - Rate limiting per device/admin

2. **Command Authorization**
   - Role-based access control for destructive commands
   - Confirmation required for WIPE, FACTORY_RESET

3. **Data Privacy**
   - Location tracking opt-in
   - Telemetry retention policies
   - Audit log access control

4. **File Security**
   - Virus scanning for uploads
   - File type restrictions
   - Size limits

---

## Open Questions

1. **Authentication**: Implement JWT-based admin auth in Phase 1 or defer?
2. **Multi-tenancy**: Support multiple organizations on same server?
3. **Location tracking**: Include in telemetry or separate opt-in feature?
4. **Shell commands**: Allow RUN_SHELL for MDM admins? Security implications?
5. **Offline queuing**: How long to retain pending commands for offline devices?

---

## References

- [OpenSTF Architecture](https://github.com/DeviceFarmer/stf)
- [Headwind MDM Documentation](https://h-mdm.com/docs/)
- [Android Enterprise APIs](https://developer.android.com/work/dpc/build-dpc)
- [Device Policy Controller Guide](https://source.android.com/docs/devices/admin)
