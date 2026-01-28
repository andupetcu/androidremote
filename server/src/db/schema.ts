import type Database from 'better-sqlite3';

/**
 * All supported command types for MDM
 */
export const COMMAND_TYPES = [
  // Existing
  'INSTALL_APK', 'UNINSTALL_APP', 'LOCK', 'REBOOT', 'WIPE', 'START_REMOTE',
  // App Management
  'UPDATE_APP', 'CLEAR_APP_DATA', 'CLEAR_APP_CACHE', 'ENABLE_APP', 'DISABLE_APP',
  'SET_DEFAULT_APP', 'LAUNCH_APP', 'STOP_APP',
  // Device Control
  'UNLOCK', 'SET_VOLUME', 'SET_BRIGHTNESS', 'TAKE_SCREENSHOT', 'SCREEN_ON', 'SCREEN_OFF',
  // Security
  'LOST_MODE', 'EXIT_LOST_MODE', 'SET_PASSWORD', 'CLEAR_PASSWORD', 'ENCRYPT_DEVICE',
  // Policy
  'SYNC_POLICY', 'CHECK_COMPLIANCE',
  // Telemetry
  'REFRESH_TELEMETRY', 'GET_LOCATION', 'SYNC_APPS',
  // Files
  'LIST_FILES', 'DOWNLOAD_FILE', 'UPLOAD_FILE', 'DELETE_FILE',
  // Shell
  'RUN_SHELL',
  // Messaging
  'SEND_MESSAGE', 'PLAY_SOUND',
] as const;

/**
 * Initialize the database schema
 */
export function initializeSchema(db: Database.Database): void {
  // ============================================
  // Phase 3: Policies (must be created before devices for FK)
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS policies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      priority INTEGER DEFAULT 0,

      -- Kiosk
      kiosk_mode INTEGER DEFAULT 0,
      kiosk_package TEXT,
      kiosk_exit_password TEXT,

      -- Apps
      app_whitelist TEXT,
      app_blacklist TEXT,
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
      allowed_wifi_ssids TEXT,

      -- Development
      adb_enabled INTEGER DEFAULT 0,
      developer_options_enabled INTEGER DEFAULT 0,

      -- System
      allow_factory_reset INTEGER DEFAULT 1,
      allow_ota_updates INTEGER DEFAULT 1,
      allow_date_time_change INTEGER DEFAULT 1,

      -- Required apps (JSON array of objects with packageName, autoStart, foreground, autoStartOnBoot)
      required_apps TEXT,

      -- Sound / Notifications
      silent_mode INTEGER DEFAULT 0,

      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // ============================================
  // Phase 3: Device Groups (must be created before devices for FK)
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      policy_id TEXT REFERENCES policies(id) ON DELETE SET NULL,
      parent_group_id TEXT REFERENCES device_groups(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // ============================================
  // Phase 1: Devices table (extended)
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      model TEXT,
      android_version TEXT,
      enrolled_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      last_seen_at INTEGER,
      status TEXT DEFAULT 'offline' CHECK(status IN ('online', 'offline')),
      public_key TEXT,

      -- Extended device info (Phase 1)
      manufacturer TEXT,
      serial_number TEXT,
      imei TEXT,
      phone_number TEXT,
      build_fingerprint TEXT,
      kernel_version TEXT,
      display_resolution TEXT,
      cpu_architecture TEXT,
      total_ram INTEGER,

      -- Group and policy assignment (Phase 3)
      group_id TEXT REFERENCES device_groups(id) ON DELETE SET NULL,
      policy_id TEXT REFERENCES policies(id) ON DELETE SET NULL,
      compliance_status TEXT DEFAULT 'pending' CHECK(compliance_status IN ('compliant', 'non_compliant', 'pending'))
    )
  `);

  // ============================================
  // Schema migrations: Add columns to existing tables
  // ============================================
  // SQLite doesn't support ADD COLUMN IF NOT EXISTS, so we check pragma first
  const existingColumns = db.prepare(`PRAGMA table_info(devices)`).all() as Array<{ name: string }>;
  const columnNames = new Set(existingColumns.map((c) => c.name));

  // Add Phase 1 extended columns if missing
  const extendedColumns = [
    { name: 'manufacturer', type: 'TEXT' },
    { name: 'serial_number', type: 'TEXT' },
    { name: 'imei', type: 'TEXT' },
    { name: 'phone_number', type: 'TEXT' },
    { name: 'build_fingerprint', type: 'TEXT' },
    { name: 'kernel_version', type: 'TEXT' },
    { name: 'display_resolution', type: 'TEXT' },
    { name: 'cpu_architecture', type: 'TEXT' },
    { name: 'total_ram', type: 'INTEGER' },
    { name: 'group_id', type: 'TEXT' },
    { name: 'policy_id', type: 'TEXT' },
    { name: 'compliance_status', type: 'TEXT DEFAULT \'pending\'' },
  ];

  for (const col of extendedColumns) {
    if (!columnNames.has(col.name)) {
      db.exec(`ALTER TABLE devices ADD COLUMN ${col.name} ${col.type}`);
    }
  }

  // Migrate policies table - add new columns if missing
  const existingPolicyColumns = db.prepare(`PRAGMA table_info(policies)`).all() as Array<{ name: string }>;
  const policyColumnNames = new Set(existingPolicyColumns.map((c) => c.name));

  const policyMigrations = [
    { name: 'silent_mode', type: 'INTEGER DEFAULT 0' },
  ];

  for (const col of policyMigrations) {
    if (!policyColumnNames.has(col.name)) {
      db.exec(`ALTER TABLE policies ADD COLUMN ${col.name} ${col.type}`);
    }
  }

  // Pairing sessions table - ephemeral, 5 min TTL
  // Note: device_id is NOT a foreign key because the device doesn't exist yet
  // when the pairing session is created. The device is enrolled only after
  // pairing completes successfully.
  db.exec(`
    CREATE TABLE IF NOT EXISTS pairing_sessions (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      pairing_code TEXT UNIQUE NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      expires_at INTEGER NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'paired', 'expired')),
      controller_public_key TEXT,
      device_public_key TEXT,
      session_token TEXT
    )
  `);

  // Create index for pairing code lookups
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pairing_sessions_code ON pairing_sessions(pairing_code)
  `);

  // Create index for device_id lookups
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pairing_sessions_device ON pairing_sessions(device_id)
  `);

  // Sessions table - active session tokens
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      last_activity INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
    )
  `);

  // Create index for device sessions lookup
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_device ON sessions(device_id)
  `);

  // Enrollment tokens table - admin-created tokens for device enrollment
  db.exec(`
    CREATE TABLE IF NOT EXISTS enrollment_tokens (
      id TEXT PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      max_uses INTEGER DEFAULT 1,
      used_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'exhausted', 'revoked', 'expired'))
    )
  `);

  // Create index for token lookups
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_enrollment_tokens_token ON enrollment_tokens(token)
  `);

  // Device commands table - queued commands for devices (Phase 4: expanded types)
  const commandTypeCheck = COMMAND_TYPES.map(t => `'${t}'`).join(', ');

  // Check if device_commands table exists and needs migration
  const tableExists = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='device_commands'
  `).get();

  if (tableExists) {
    // Check if the CHECK constraint needs updating by trying to get the table schema
    // SQLite doesn't let us modify CHECK constraints, so we need to recreate the table
    // We detect this by checking if the constraint string length has changed
    const tableInfo = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='device_commands'`).get() as { sql: string } | undefined;
    const currentSql = tableInfo?.sql || '';

    // If the current schema doesn't include all command types, recreate the table
    const hasAllTypes = COMMAND_TYPES.every(t => currentSql.includes(`'${t}'`));

    if (!hasAllTypes) {
      // Migrate: rename old table, create new, copy data, drop old
      db.exec(`ALTER TABLE device_commands RENAME TO device_commands_old`);

      db.exec(`
        CREATE TABLE device_commands (
          id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN (${commandTypeCheck})),
          payload TEXT NOT NULL,
          status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'delivered', 'executing', 'completed', 'failed')),
          created_at INTEGER NOT NULL,
          delivered_at INTEGER,
          completed_at INTEGER,
          error TEXT,
          FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
        )
      `);

      // Copy existing data (only valid command types will be copied)
      db.exec(`
        INSERT INTO device_commands
        SELECT * FROM device_commands_old
        WHERE type IN (${commandTypeCheck})
      `);

      db.exec(`DROP TABLE device_commands_old`);
    }
  } else {
    db.exec(`
      CREATE TABLE device_commands (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN (${commandTypeCheck})),
        payload TEXT NOT NULL,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'delivered', 'executing', 'completed', 'failed')),
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        completed_at INTEGER,
        error TEXT,
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
      )
    `);
  }

  // Create indexes for command lookups
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_device_commands_device ON device_commands(device_id)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_device_commands_pending ON device_commands(device_id, status) WHERE status = 'pending'
  `);

  // ============================================
  // Phase 1: Device Telemetry
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_telemetry (
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
    )
  `);

  // Telemetry history for trends
  db.exec(`
    CREATE TABLE IF NOT EXISTS telemetry_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      battery_level INTEGER,
      network_type TEXT,
      storage_used_bytes INTEGER,
      memory_used_bytes INTEGER,
      recorded_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_telemetry_history_device ON telemetry_history(device_id, recorded_at DESC)
  `);

  // ============================================
  // Phase 2: Application Inventory
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_apps (
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
      permissions TEXT,
      PRIMARY KEY (device_id, package_name)
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_device_apps_package ON device_apps(package_name)
  `);

  // App catalog - known apps across fleet
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_catalog (
      package_name TEXT PRIMARY KEY,
      app_name TEXT,
      latest_version_name TEXT,
      latest_version_code INTEGER,
      category TEXT,
      is_approved INTEGER DEFAULT 0,
      is_blocked INTEGER DEFAULT 0,
      notes TEXT,
      updated_at INTEGER
    )
  `);

  // ============================================
  // App Packages - uploaded APKs for installation
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_packages (
      id TEXT PRIMARY KEY,
      package_name TEXT NOT NULL UNIQUE,
      app_name TEXT,
      version_name TEXT,
      version_code INTEGER,
      file_size INTEGER,
      file_path TEXT NOT NULL,
      uploaded_at INTEGER NOT NULL,
      uploaded_by TEXT
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_app_packages_package ON app_packages(package_name)
  `);

  // ============================================
  // Phase 3: Device Group Members
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_group_members (
      group_id TEXT NOT NULL REFERENCES device_groups(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (group_id, device_id)
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_group_members_device ON device_group_members(device_id)
  `);

  // ============================================
  // Phase 5: Device Events
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('info', 'warning', 'critical')),
      data TEXT,
      acknowledged INTEGER DEFAULT 0,
      acknowledged_at INTEGER,
      acknowledged_by TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_device_events_device ON device_events(device_id, created_at DESC)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_device_events_type ON device_events(event_type, created_at DESC)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_device_events_unack ON device_events(acknowledged, severity) WHERE acknowledged = 0
  `);

  // ============================================
  // Phase 6: File Transfers
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_transfers (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK(direction IN ('upload', 'download')),
      device_path TEXT NOT NULL,
      server_path TEXT,
      file_name TEXT,
      file_size INTEGER,
      mime_type TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'transferring', 'completed', 'failed', 'cancelled')),
      progress INTEGER DEFAULT 0,
      error TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_file_transfers_device ON file_transfers(device_id, created_at DESC)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_file_transfers_status ON file_transfers(status) WHERE status IN ('pending', 'transferring')
  `);

  // ============================================
  // Phase 7: Audit Logs
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      actor_type TEXT NOT NULL CHECK(actor_type IN ('admin', 'device', 'system')),
      actor_id TEXT,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      details TEXT,
      ip_address TEXT
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp DESC)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_type, actor_id)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource_type, resource_id)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action)
  `);
}

/**
 * Clean up expired enrollment tokens
 */
export function cleanupExpiredTokens(db: Database.Database): number {
  const now = Date.now();
  const result = db.prepare(`
    UPDATE enrollment_tokens
    SET status = 'expired'
    WHERE status = 'active' AND expires_at < ?
  `).run(now);
  return result.changes;
}

/**
 * Clean up expired pairing sessions
 */
export function cleanupExpiredSessions(db: Database.Database): number {
  const now = Date.now();
  const result = db.prepare(`
    UPDATE pairing_sessions
    SET status = 'expired'
    WHERE status = 'pending' AND expires_at < ?
  `).run(now);
  return result.changes;
}

/**
 * Delete old expired sessions (older than 1 hour)
 */
export function purgeOldSessions(db: Database.Database): number {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const result = db.prepare(`
    DELETE FROM pairing_sessions
    WHERE status = 'expired' AND expires_at < ?
  `).run(oneHourAgo);
  return result.changes;
}

/**
 * Purge old telemetry history (older than specified days)
 */
export function purgeTelemetryHistory(db: Database.Database, olderThanDays: number = 7): number {
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const result = db.prepare(`
    DELETE FROM telemetry_history WHERE recorded_at < ?
  `).run(cutoff);
  return result.changes;
}

/**
 * Purge old device events (older than specified days)
 */
export function purgeOldEvents(db: Database.Database, olderThanDays: number = 30): number {
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const result = db.prepare(`
    DELETE FROM device_events WHERE created_at < ?
  `).run(cutoff);
  return result.changes;
}

/**
 * Purge old audit logs (older than specified days)
 */
export function purgeOldAuditLogs(db: Database.Database, olderThanDays: number = 90): number {
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const result = db.prepare(`
    DELETE FROM audit_logs WHERE timestamp < ?
  `).run(cutoff);
  return result.changes;
}

/**
 * Clean up completed/failed file transfers (older than specified days)
 */
export function purgeOldFileTransfers(db: Database.Database, olderThanDays: number = 7): number {
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const result = db.prepare(`
    DELETE FROM file_transfers
    WHERE status IN ('completed', 'failed', 'cancelled') AND created_at < ?
  `).run(cutoff);
  return result.changes;
}
