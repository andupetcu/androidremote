// Device types
export interface Device {
  id: string;
  name: string;
  model: string | null;
  androidVersion: string | null;
  enrolledAt: number;
  lastSeenAt: number | null;
  status: 'online' | 'offline';
  publicKey: string | null;
  manufacturer: string | null;
  serialNumber: string | null;
  imei: string | null;
  phoneNumber: string | null;
  buildFingerprint: string | null;
  kernelVersion: string | null;
  displayResolution: string | null;
  cpuArchitecture: string | null;
  totalRam: number | null;
  groupId: string | null;
  policyId: string | null;
  complianceStatus: 'compliant' | 'non_compliant' | 'pending';
  // Cross-platform agent fields
  osType: string;
  osVersionGeneric: string | null;
  hostname: string | null;
  agentVersion: string | null;
  arch: string | null;
  capabilities: number;
}

// Telemetry types
export interface DeviceTelemetry {
  deviceId: string;
  batteryLevel: number | null;
  batteryCharging: boolean | null;
  batteryHealth: string | null;
  networkType: string | null;
  networkStrength: number | null;
  wifiSsid: string | null;
  ipAddress: string | null;
  storageTotal: number | null;
  storageUsed: number | null;
  memoryTotal: number | null;
  memoryUsed: number | null;
  latitude: number | null;
  longitude: number | null;
  locationAccuracy: number | null;
  locationUpdatedAt: number | null;
  updatedAt: number;
}

export interface TelemetryHistory {
  id: string;
  deviceId: string;
  batteryLevel: number | null;
  storageUsed: number | null;
  memoryUsed: number | null;
  networkType: string | null;
  recordedAt: number;
}

// Group types
export interface Group {
  id: string;
  name: string;
  description: string | null;
  parentId: string | null;
  policyId: string | null;
  createdAt: number;
  updatedAt: number;
  deviceCount?: number;
}

export interface GroupInput {
  name: string;
  description?: string;
  parentId?: string;
  policyId?: string;
}

// Required app configuration in policy
export interface RequiredAppConfig {
  packageName: string;
  autoStartAfterInstall?: boolean;   // Launch app after installation
  foregroundApp?: boolean;           // This is the primary foreground app (only one per policy)
  autoStartOnBoot?: boolean;         // Start app on device boot
}

// Policy types
export interface Policy {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  kioskMode: boolean;
  kioskPackage: string | null;
  kioskExitPassword: string | null;
  allowedApps: string[] | null;
  blockedApps: string[] | null;
  playStoreEnabled: boolean;
  unknownSourcesEnabled: boolean;
  passwordRequired: boolean;
  passwordMinLength: number | null;
  passwordComplexity: string | null;
  encryptionRequired: boolean;
  maxFailedAttempts: number | null;
  cameraEnabled: boolean;
  microphoneEnabled: boolean;
  bluetoothEnabled: boolean;
  wifiEnabled: boolean;
  usbEnabled: boolean;
  sdCardEnabled: boolean;
  vpnRequired: boolean;
  allowedWifiSsids: string[] | null;
  adbEnabled: boolean;
  developerOptionsEnabled: boolean;
  factoryResetEnabled: boolean;
  otaUpdatesEnabled: boolean;
  requiredApps: RequiredAppConfig[] | null;
  silentMode: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface PolicyInput {
  name: string;
  description?: string;
  isDefault?: boolean;
  kioskMode?: boolean;
  kioskPackage?: string;
  kioskExitPassword?: string;
  allowedApps?: string[];
  blockedApps?: string[];
  playStoreEnabled?: boolean;
  unknownSourcesEnabled?: boolean;
  passwordRequired?: boolean;
  passwordMinLength?: number;
  passwordComplexity?: string;
  encryptionRequired?: boolean;
  maxFailedAttempts?: number;
  cameraEnabled?: boolean;
  microphoneEnabled?: boolean;
  bluetoothEnabled?: boolean;
  wifiEnabled?: boolean;
  usbEnabled?: boolean;
  sdCardEnabled?: boolean;
  vpnRequired?: boolean;
  allowedWifiSsids?: string[];
  adbEnabled?: boolean;
  developerOptionsEnabled?: boolean;
  factoryResetEnabled?: boolean;
  otaUpdatesEnabled?: boolean;
  requiredApps?: RequiredAppConfig[];
  silentMode?: boolean;
}

// Event types
export type EventSeverity = 'info' | 'warning' | 'critical';

export type DeviceEventType =
  | 'device-online'
  | 'device-offline'
  | 'battery-low'
  | 'battery-critical'
  | 'storage-low'
  | 'storage-critical'
  | 'app-installed'
  | 'app-uninstalled'
  | 'policy-violation'
  | 'command-completed'
  | 'command-failed'
  | 'location-updated'
  | 'compliance-changed';

export interface DeviceEvent {
  id: string;
  deviceId: string;
  eventType: DeviceEventType;
  severity: EventSeverity;
  data: Record<string, unknown>;
  acknowledged: boolean;
  acknowledgedAt: number | null;
  acknowledgedBy: string | null;
  createdAt: number;
}

export interface EventInput {
  deviceId: string;
  eventType: DeviceEventType;
  severity: EventSeverity;
  data?: Record<string, unknown>;
}

// App types
export interface AppInfo {
  packageName: string;
  appName: string | null;
  versionName: string | null;
  versionCode: number | null;
  installedAt: number | null;
  updatedAt: number | null;
  isSystemApp: boolean;
  isEnabled: boolean;
}

export interface AppCatalogEntry {
  packageName: string;
  appName: string | null;
  category: string | null;
  status: 'approved' | 'blocked' | 'pending';
  adminNotes: string | null;
  deviceCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

// File transfer types
export type TransferDirection = 'upload' | 'download';
export type TransferStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

export interface FileTransfer {
  id: string;
  deviceId: string;
  direction: TransferDirection;
  remotePath: string;
  localPath: string | null;
  fileSize: number | null;
  transferredBytes: number;
  status: TransferStatus;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

// Command types
export type CommandType =
  | 'INSTALL_APK'
  | 'UNINSTALL_APP'
  | 'LOCK'
  | 'REBOOT'
  | 'WIPE'
  | 'START_REMOTE'
  | 'UPDATE_APP'
  | 'CLEAR_APP_DATA'
  | 'CLEAR_APP_CACHE'
  | 'ENABLE_APP'
  | 'DISABLE_APP'
  | 'SET_DEFAULT_APP'
  | 'LAUNCH_APP'
  | 'STOP_APP'
  | 'UNLOCK'
  | 'SET_VOLUME'
  | 'SET_BRIGHTNESS'
  | 'TAKE_SCREENSHOT'
  | 'SCREEN_ON'
  | 'SCREEN_OFF'
  | 'LOST_MODE'
  | 'EXIT_LOST_MODE'
  | 'SET_PASSWORD'
  | 'CLEAR_PASSWORD'
  | 'ENCRYPT_DEVICE'
  | 'SYNC_POLICY'
  | 'CHECK_COMPLIANCE'
  | 'REFRESH_TELEMETRY'
  | 'GET_LOCATION'
  | 'SYNC_APPS'
  | 'LIST_FILES'
  | 'DOWNLOAD_FILE'
  | 'UPLOAD_FILE'
  | 'DELETE_FILE'
  | 'RUN_SHELL'
  | 'SEND_MESSAGE'
  | 'PLAY_SOUND';

export type CommandStatus = 'pending' | 'delivered' | 'executing' | 'completed' | 'failed';

export interface DeviceCommand {
  id: string;
  deviceId: string;
  type: CommandType;
  payload: Record<string, unknown>;
  status: CommandStatus;
  createdAt: number;
  deliveredAt?: number;
  completedAt?: number;
  error?: string;
}

// Audit types
export type ActorType = 'admin' | 'device' | 'system';

export type AuditAction =
  | 'device.enrolled'
  | 'device.unenrolled'
  | 'device.renamed'
  | 'device.group_changed'
  | 'device.policy_changed'
  | 'command.queued'
  | 'command.completed'
  | 'command.failed'
  | 'command.cancelled'
  | 'policy.created'
  | 'policy.updated'
  | 'policy.deleted'
  | 'policy.assigned'
  | 'group.created'
  | 'group.updated'
  | 'group.deleted'
  | 'group.device_added'
  | 'group.device_removed'
  | 'app.approved'
  | 'app.blocked'
  | 'app.installed'
  | 'app.uninstalled'
  | 'file.upload_requested'
  | 'file.download_requested'
  | 'file.transfer_completed'
  | 'file.transfer_failed'
  | 'admin.login'
  | 'admin.logout'
  | 'token.created'
  | 'token.revoked'
  | 'event.acknowledged';

export type ResourceType = 'device' | 'policy' | 'group' | 'command' | 'app' | 'token' | 'file' | 'event';

export interface AuditLog {
  id: string;
  timestamp: number;
  actorType: ActorType;
  actorId: string | null;
  action: AuditAction;
  resourceType: ResourceType;
  resourceId: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
}

// Enrollment types
export interface EnrollmentToken {
  id: string;
  token: string;
  createdAt: number;
  expiresAt: number | null;
  maxUses: number | null;
  usedCount: number;
  isActive: boolean;
}
