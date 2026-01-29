import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { getDatabase } from '../db/connection';
import { initializeSchema } from '../db/schema';

/**
 * Configuration for a required app in policy
 */
export interface RequiredAppConfig {
  packageName: string;
  autoStartAfterInstall?: boolean;   // Launch app after installation
  foregroundApp?: boolean;           // This is the primary foreground app (only one per policy)
  autoStartOnBoot?: boolean;         // Start app on device boot
}

export interface Policy {
  id: string;
  name: string;
  description: string | null;
  priority: number;
  isDefault: boolean;

  // Kiosk
  kioskMode: boolean;
  kioskPackage: string | null;
  kioskExitPassword: string | null;

  // Apps
  appWhitelist: string[] | null;
  appBlacklist: string[] | null;
  allowUnknownSources: boolean;
  allowPlayStore: boolean;

  // Security
  passwordRequired: boolean;
  passwordMinLength: number | null;
  passwordRequireNumeric: boolean;
  passwordRequireSymbol: boolean;
  maxPasswordAge: number | null;
  maxFailedAttempts: number | null;
  lockAfterInactivity: number | null;
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
  vpnPackage: string | null;
  allowedWifiSsids: string[] | null;

  // Development
  adbEnabled: boolean;
  developerOptionsEnabled: boolean;

  // System
  allowFactoryReset: boolean;
  allowOtaUpdates: boolean;
  allowDateTimeChange: boolean;

  // Required apps (auto-install on devices with this policy)
  requiredApps: RequiredAppConfig[] | null;

  // Sound / Notifications
  silentMode: boolean;

  createdAt: number;
  updatedAt: number;
}

export interface PolicyInput {
  name: string;
  description?: string;
  priority?: number;
  isDefault?: boolean;

  kioskMode?: boolean;
  kioskPackage?: string;
  kioskExitPassword?: string;

  appWhitelist?: string[];
  appBlacklist?: string[];
  allowUnknownSources?: boolean;
  allowPlayStore?: boolean;

  passwordRequired?: boolean;
  passwordMinLength?: number;
  passwordRequireNumeric?: boolean;
  passwordRequireSymbol?: boolean;
  maxPasswordAge?: number;
  maxFailedAttempts?: number;
  lockAfterInactivity?: number;
  encryptionRequired?: boolean;

  cameraEnabled?: boolean;
  microphoneEnabled?: boolean;
  bluetoothEnabled?: boolean;
  wifiEnabled?: boolean;
  nfcEnabled?: boolean;
  usbEnabled?: boolean;
  sdCardEnabled?: boolean;

  vpnRequired?: boolean;
  vpnPackage?: string;
  allowedWifiSsids?: string[];

  adbEnabled?: boolean;
  developerOptionsEnabled?: boolean;

  allowFactoryReset?: boolean;
  allowOtaUpdates?: boolean;
  allowDateTimeChange?: boolean;

  requiredApps?: RequiredAppConfig[];

  silentMode?: boolean;
}

interface PolicyRow {
  id: string;
  name: string;
  description: string | null;
  priority: number;
  is_default: number;

  kiosk_mode: number;
  kiosk_package: string | null;
  kiosk_exit_password: string | null;

  app_whitelist: string | null;
  app_blacklist: string | null;
  allow_unknown_sources: number;
  allow_play_store: number;

  password_required: number;
  password_min_length: number | null;
  password_require_numeric: number;
  password_require_symbol: number;
  max_password_age: number | null;
  max_failed_attempts: number | null;
  lock_after_inactivity: number | null;
  encryption_required: number;

  camera_enabled: number;
  microphone_enabled: number;
  bluetooth_enabled: number;
  wifi_enabled: number;
  nfc_enabled: number;
  usb_enabled: number;
  sd_card_enabled: number;

  vpn_required: number;
  vpn_package: string | null;
  allowed_wifi_ssids: string | null;

  adb_enabled: number;
  developer_options_enabled: number;

  allow_factory_reset: number;
  allow_ota_updates: number;
  allow_date_time_change: number;

  required_apps: string | null;

  silent_mode: number;

  created_at: number;
  updated_at: number;
}

class PolicyStore {
  private db: Database.Database | null = null;
  private initialized = false;

  private getDb(): Database.Database {
    if (!this.db) {
      this.db = getDatabase();
    }
    return this.db;
  }

  private initialize(): void {
    if (!this.initialized) {
      initializeSchema(this.getDb());
      this.initialized = true;
    }
  }

  setDatabase(database: Database.Database): void {
    this.db = database;
    this.initialized = false;
    initializeSchema(database);
    this.initialized = true;
  }

  resetDatabase(): void {
    this.db = null;
    this.initialized = false;
  }

  private generateId(): string {
    return `pol-${crypto.randomBytes(8).toString('hex')}`;
  }

  /**
   * Create a new policy
   */
  createPolicy(input: PolicyInput): Policy {
    this.initialize();
    const db = this.getDb();
    const now = Date.now();
    const id = this.generateId();

    // If setting this policy as default, clear default on all others
    if (input.isDefault) {
      db.prepare('UPDATE policies SET is_default = 0 WHERE is_default = 1').run();
    }

    db.prepare(`
      INSERT INTO policies (
        id, name, description, priority, is_default,
        kiosk_mode, kiosk_package, kiosk_exit_password,
        app_whitelist, app_blacklist, allow_unknown_sources, allow_play_store,
        password_required, password_min_length, password_require_numeric, password_require_symbol,
        max_password_age, max_failed_attempts, lock_after_inactivity, encryption_required,
        camera_enabled, microphone_enabled, bluetooth_enabled, wifi_enabled, nfc_enabled, usb_enabled, sd_card_enabled,
        vpn_required, vpn_package, allowed_wifi_ssids,
        adb_enabled, developer_options_enabled,
        allow_factory_reset, allow_ota_updates, allow_date_time_change,
        required_apps, silent_mode,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.name,
      input.description ?? null,
      input.priority ?? 0,
      input.isDefault ? 1 : 0,
      input.kioskMode ? 1 : 0,
      input.kioskPackage ?? null,
      input.kioskExitPassword ?? null,
      input.appWhitelist ? JSON.stringify(input.appWhitelist) : null,
      input.appBlacklist ? JSON.stringify(input.appBlacklist) : null,
      input.allowUnknownSources ? 1 : 0,
      input.allowPlayStore !== false ? 1 : 0,
      input.passwordRequired ? 1 : 0,
      input.passwordMinLength ?? null,
      input.passwordRequireNumeric ? 1 : 0,
      input.passwordRequireSymbol ? 1 : 0,
      input.maxPasswordAge ?? null,
      input.maxFailedAttempts ?? null,
      input.lockAfterInactivity ?? null,
      input.encryptionRequired ? 1 : 0,
      input.cameraEnabled !== false ? 1 : 0,
      input.microphoneEnabled !== false ? 1 : 0,
      input.bluetoothEnabled !== false ? 1 : 0,
      input.wifiEnabled !== false ? 1 : 0,
      input.nfcEnabled !== false ? 1 : 0,
      input.usbEnabled !== false ? 1 : 0,
      input.sdCardEnabled !== false ? 1 : 0,
      input.vpnRequired ? 1 : 0,
      input.vpnPackage ?? null,
      input.allowedWifiSsids ? JSON.stringify(input.allowedWifiSsids) : null,
      input.adbEnabled ? 1 : 0,
      input.developerOptionsEnabled ? 1 : 0,
      input.allowFactoryReset !== false ? 1 : 0,
      input.allowOtaUpdates !== false ? 1 : 0,
      input.allowDateTimeChange !== false ? 1 : 0,
      input.requiredApps ? JSON.stringify(input.requiredApps) : null,
      input.silentMode ? 1 : 0,
      now,
      now
    );

    return this.getPolicy(id)!;
  }

  /**
   * Get a policy by ID
   */
  getPolicy(id: string): Policy | null {
    this.initialize();
    const db = this.getDb();

    const row = db.prepare('SELECT * FROM policies WHERE id = ?').get(id) as PolicyRow | undefined;
    if (!row) return null;
    return this.rowToPolicy(row);
  }

  /**
   * Get all policies
   */
  getAllPolicies(): Policy[] {
    this.initialize();
    const db = this.getDb();

    const rows = db.prepare('SELECT * FROM policies ORDER BY priority DESC, name ASC').all() as PolicyRow[];
    return rows.map(row => this.rowToPolicy(row));
  }

  /**
   * Update a policy
   */
  updatePolicy(id: string, updates: Partial<PolicyInput>): Policy | null {
    this.initialize();
    const db = this.getDb();

    const existing = this.getPolicy(id);
    if (!existing) return null;

    // If setting this policy as default, clear default on all others
    if (updates.isDefault) {
      db.prepare('UPDATE policies SET is_default = 0 WHERE is_default = 1').run();
    }

    db.prepare(`
      UPDATE policies SET
        name = ?,
        description = ?,
        priority = ?,
        is_default = ?,
        kiosk_mode = ?,
        kiosk_package = ?,
        kiosk_exit_password = ?,
        app_whitelist = ?,
        app_blacklist = ?,
        allow_unknown_sources = ?,
        allow_play_store = ?,
        password_required = ?,
        password_min_length = ?,
        password_require_numeric = ?,
        password_require_symbol = ?,
        max_password_age = ?,
        max_failed_attempts = ?,
        lock_after_inactivity = ?,
        encryption_required = ?,
        camera_enabled = ?,
        microphone_enabled = ?,
        bluetooth_enabled = ?,
        wifi_enabled = ?,
        nfc_enabled = ?,
        usb_enabled = ?,
        sd_card_enabled = ?,
        vpn_required = ?,
        vpn_package = ?,
        allowed_wifi_ssids = ?,
        adb_enabled = ?,
        developer_options_enabled = ?,
        allow_factory_reset = ?,
        allow_ota_updates = ?,
        allow_date_time_change = ?,
        required_apps = ?,
        silent_mode = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      updates.name ?? existing.name,
      updates.description !== undefined ? updates.description : existing.description,
      updates.priority ?? existing.priority,
      updates.isDefault !== undefined ? (updates.isDefault ? 1 : 0) : (existing.isDefault ? 1 : 0),
      updates.kioskMode !== undefined ? (updates.kioskMode ? 1 : 0) : (existing.kioskMode ? 1 : 0),
      updates.kioskPackage !== undefined ? updates.kioskPackage : existing.kioskPackage,
      updates.kioskExitPassword !== undefined ? updates.kioskExitPassword : existing.kioskExitPassword,
      updates.appWhitelist !== undefined ? (updates.appWhitelist ? JSON.stringify(updates.appWhitelist) : null) : (existing.appWhitelist ? JSON.stringify(existing.appWhitelist) : null),
      updates.appBlacklist !== undefined ? (updates.appBlacklist ? JSON.stringify(updates.appBlacklist) : null) : (existing.appBlacklist ? JSON.stringify(existing.appBlacklist) : null),
      updates.allowUnknownSources !== undefined ? (updates.allowUnknownSources ? 1 : 0) : (existing.allowUnknownSources ? 1 : 0),
      updates.allowPlayStore !== undefined ? (updates.allowPlayStore ? 1 : 0) : (existing.allowPlayStore ? 1 : 0),
      updates.passwordRequired !== undefined ? (updates.passwordRequired ? 1 : 0) : (existing.passwordRequired ? 1 : 0),
      updates.passwordMinLength !== undefined ? updates.passwordMinLength : existing.passwordMinLength,
      updates.passwordRequireNumeric !== undefined ? (updates.passwordRequireNumeric ? 1 : 0) : (existing.passwordRequireNumeric ? 1 : 0),
      updates.passwordRequireSymbol !== undefined ? (updates.passwordRequireSymbol ? 1 : 0) : (existing.passwordRequireSymbol ? 1 : 0),
      updates.maxPasswordAge !== undefined ? updates.maxPasswordAge : existing.maxPasswordAge,
      updates.maxFailedAttempts !== undefined ? updates.maxFailedAttempts : existing.maxFailedAttempts,
      updates.lockAfterInactivity !== undefined ? updates.lockAfterInactivity : existing.lockAfterInactivity,
      updates.encryptionRequired !== undefined ? (updates.encryptionRequired ? 1 : 0) : (existing.encryptionRequired ? 1 : 0),
      updates.cameraEnabled !== undefined ? (updates.cameraEnabled ? 1 : 0) : (existing.cameraEnabled ? 1 : 0),
      updates.microphoneEnabled !== undefined ? (updates.microphoneEnabled ? 1 : 0) : (existing.microphoneEnabled ? 1 : 0),
      updates.bluetoothEnabled !== undefined ? (updates.bluetoothEnabled ? 1 : 0) : (existing.bluetoothEnabled ? 1 : 0),
      updates.wifiEnabled !== undefined ? (updates.wifiEnabled ? 1 : 0) : (existing.wifiEnabled ? 1 : 0),
      updates.nfcEnabled !== undefined ? (updates.nfcEnabled ? 1 : 0) : (existing.nfcEnabled ? 1 : 0),
      updates.usbEnabled !== undefined ? (updates.usbEnabled ? 1 : 0) : (existing.usbEnabled ? 1 : 0),
      updates.sdCardEnabled !== undefined ? (updates.sdCardEnabled ? 1 : 0) : (existing.sdCardEnabled ? 1 : 0),
      updates.vpnRequired !== undefined ? (updates.vpnRequired ? 1 : 0) : (existing.vpnRequired ? 1 : 0),
      updates.vpnPackage !== undefined ? updates.vpnPackage : existing.vpnPackage,
      updates.allowedWifiSsids !== undefined ? (updates.allowedWifiSsids ? JSON.stringify(updates.allowedWifiSsids) : null) : (existing.allowedWifiSsids ? JSON.stringify(existing.allowedWifiSsids) : null),
      updates.adbEnabled !== undefined ? (updates.adbEnabled ? 1 : 0) : (existing.adbEnabled ? 1 : 0),
      updates.developerOptionsEnabled !== undefined ? (updates.developerOptionsEnabled ? 1 : 0) : (existing.developerOptionsEnabled ? 1 : 0),
      updates.allowFactoryReset !== undefined ? (updates.allowFactoryReset ? 1 : 0) : (existing.allowFactoryReset ? 1 : 0),
      updates.allowOtaUpdates !== undefined ? (updates.allowOtaUpdates ? 1 : 0) : (existing.allowOtaUpdates ? 1 : 0),
      updates.allowDateTimeChange !== undefined ? (updates.allowDateTimeChange ? 1 : 0) : (existing.allowDateTimeChange ? 1 : 0),
      updates.requiredApps !== undefined ? (updates.requiredApps ? JSON.stringify(updates.requiredApps) : null) : (existing.requiredApps ? JSON.stringify(existing.requiredApps) : null),
      updates.silentMode !== undefined ? (updates.silentMode ? 1 : 0) : (existing.silentMode ? 1 : 0),
      Date.now(),
      id
    );

    return this.getPolicy(id);
  }

  /**
   * Delete a policy
   */
  deletePolicy(id: string): boolean {
    this.initialize();
    const db = this.getDb();

    const result = db.prepare('DELETE FROM policies WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /**
   * Get policy count
   */
  getPolicyCount(): number {
    this.initialize();
    const db = this.getDb();

    const row = db.prepare('SELECT COUNT(*) as count FROM policies').get() as { count: number };
    return row.count;
  }

  /**
   * Get default (lowest priority) policy or null
   */
  getDefaultPolicy(): Policy | null {
    this.initialize();
    const db = this.getDb();

    // First try to find explicitly marked default policy
    const defaultRow = db.prepare('SELECT * FROM policies WHERE is_default = 1 LIMIT 1').get() as PolicyRow | undefined;
    if (defaultRow) return this.rowToPolicy(defaultRow);

    // Fall back to lowest priority
    const row = db.prepare('SELECT * FROM policies ORDER BY priority ASC, created_at ASC LIMIT 1').get() as PolicyRow | undefined;
    if (!row) return null;
    return this.rowToPolicy(row);
  }

  /**
   * Clear all policies (for testing)
   */
  clear(): void {
    this.initialize();
    const db = this.getDb();
    db.prepare('DELETE FROM policies').run();
  }

  private rowToPolicy(row: PolicyRow): Policy {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      priority: row.priority,
      isDefault: row.is_default === 1,
      kioskMode: row.kiosk_mode === 1,
      kioskPackage: row.kiosk_package,
      kioskExitPassword: row.kiosk_exit_password,
      appWhitelist: row.app_whitelist ? JSON.parse(row.app_whitelist) : null,
      appBlacklist: row.app_blacklist ? JSON.parse(row.app_blacklist) : null,
      allowUnknownSources: row.allow_unknown_sources === 1,
      allowPlayStore: row.allow_play_store === 1,
      passwordRequired: row.password_required === 1,
      passwordMinLength: row.password_min_length,
      passwordRequireNumeric: row.password_require_numeric === 1,
      passwordRequireSymbol: row.password_require_symbol === 1,
      maxPasswordAge: row.max_password_age,
      maxFailedAttempts: row.max_failed_attempts,
      lockAfterInactivity: row.lock_after_inactivity,
      encryptionRequired: row.encryption_required === 1,
      cameraEnabled: row.camera_enabled === 1,
      microphoneEnabled: row.microphone_enabled === 1,
      bluetoothEnabled: row.bluetooth_enabled === 1,
      wifiEnabled: row.wifi_enabled === 1,
      nfcEnabled: row.nfc_enabled === 1,
      usbEnabled: row.usb_enabled === 1,
      sdCardEnabled: row.sd_card_enabled === 1,
      vpnRequired: row.vpn_required === 1,
      vpnPackage: row.vpn_package,
      allowedWifiSsids: row.allowed_wifi_ssids ? JSON.parse(row.allowed_wifi_ssids) : null,
      adbEnabled: row.adb_enabled === 1,
      developerOptionsEnabled: row.developer_options_enabled === 1,
      allowFactoryReset: row.allow_factory_reset === 1,
      allowOtaUpdates: row.allow_ota_updates === 1,
      allowDateTimeChange: row.allow_date_time_change === 1,
      requiredApps: row.required_apps ? JSON.parse(row.required_apps) : null,
      silentMode: row.silent_mode === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export const policyStore = new PolicyStore();
