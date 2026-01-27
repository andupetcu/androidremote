import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { getDatabase } from '../db/connection';
import { initializeSchema } from '../db/schema';

export interface DeviceGroup {
  id: string;
  name: string;
  description: string | null;
  policyId: string | null;
  parentGroupId: string | null;
  createdAt: number;
  updatedAt: number;
  deviceCount?: number;
}

export interface GroupInput {
  name: string;
  description?: string;
  policyId?: string;
  parentGroupId?: string;
}

interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  policy_id: string | null;
  parent_group_id: string | null;
  created_at: number;
  updated_at: number;
}

interface MemberRow {
  group_id: string;
  device_id: string;
  added_at: number;
}

class GroupStore {
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
    return `grp-${crypto.randomBytes(8).toString('hex')}`;
  }

  // =============================================
  // Group CRUD
  // =============================================

  /**
   * Create a new group
   */
  createGroup(input: GroupInput): DeviceGroup {
    this.initialize();
    const db = this.getDb();
    const now = Date.now();
    const id = this.generateId();

    db.prepare(`
      INSERT INTO device_groups (id, name, description, policy_id, parent_group_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.name,
      input.description ?? null,
      input.policyId ?? null,
      input.parentGroupId ?? null,
      now,
      now
    );

    return this.getGroup(id)!;
  }

  /**
   * Get a group by ID
   */
  getGroup(id: string): DeviceGroup | null {
    this.initialize();
    const db = this.getDb();

    const row = db.prepare(`
      SELECT g.*, (SELECT COUNT(*) FROM device_group_members WHERE group_id = g.id) as device_count
      FROM device_groups g
      WHERE g.id = ?
    `).get(id) as (GroupRow & { device_count: number }) | undefined;

    if (!row) return null;
    return this.rowToGroup(row);
  }

  /**
   * Get a group by name
   */
  getGroupByName(name: string): DeviceGroup | null {
    this.initialize();
    const db = this.getDb();

    const row = db.prepare(`
      SELECT g.*, (SELECT COUNT(*) FROM device_group_members WHERE group_id = g.id) as device_count
      FROM device_groups g
      WHERE g.name = ?
    `).get(name) as (GroupRow & { device_count: number }) | undefined;

    if (!row) return null;
    return this.rowToGroup(row);
  }

  /**
   * Get all groups
   */
  getAllGroups(): DeviceGroup[] {
    this.initialize();
    const db = this.getDb();

    const rows = db.prepare(`
      SELECT g.*, (SELECT COUNT(*) FROM device_group_members WHERE group_id = g.id) as device_count
      FROM device_groups g
      ORDER BY g.name ASC
    `).all() as (GroupRow & { device_count: number })[];

    return rows.map(row => this.rowToGroup(row));
  }

  /**
   * Get child groups
   */
  getChildGroups(parentId: string): DeviceGroup[] {
    this.initialize();
    const db = this.getDb();

    const rows = db.prepare(`
      SELECT g.*, (SELECT COUNT(*) FROM device_group_members WHERE group_id = g.id) as device_count
      FROM device_groups g
      WHERE g.parent_group_id = ?
      ORDER BY g.name ASC
    `).all(parentId) as (GroupRow & { device_count: number })[];

    return rows.map(row => this.rowToGroup(row));
  }

  /**
   * Update a group
   */
  updateGroup(id: string, updates: Partial<GroupInput>): DeviceGroup | null {
    this.initialize();
    const db = this.getDb();

    const existing = this.getGroup(id);
    if (!existing) return null;

    db.prepare(`
      UPDATE device_groups SET
        name = ?,
        description = ?,
        policy_id = ?,
        parent_group_id = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      updates.name ?? existing.name,
      updates.description !== undefined ? updates.description : existing.description,
      updates.policyId !== undefined ? updates.policyId : existing.policyId,
      updates.parentGroupId !== undefined ? updates.parentGroupId : existing.parentGroupId,
      Date.now(),
      id
    );

    return this.getGroup(id);
  }

  /**
   * Delete a group
   */
  deleteGroup(id: string): boolean {
    this.initialize();
    const db = this.getDb();

    const result = db.prepare('DELETE FROM device_groups WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // =============================================
  // Group Membership
  // =============================================

  /**
   * Add device to group
   */
  addDeviceToGroup(groupId: string, deviceId: string): boolean {
    this.initialize();
    const db = this.getDb();

    try {
      db.prepare(`
        INSERT INTO device_group_members (group_id, device_id, added_at)
        VALUES (?, ?, ?)
      `).run(groupId, deviceId, Date.now());
      return true;
    } catch (e) {
      // Already exists
      return false;
    }
  }

  /**
   * Remove device from group
   */
  removeDeviceFromGroup(groupId: string, deviceId: string): boolean {
    this.initialize();
    const db = this.getDb();

    const result = db.prepare(`
      DELETE FROM device_group_members WHERE group_id = ? AND device_id = ?
    `).run(groupId, deviceId);

    return result.changes > 0;
  }

  /**
   * Get devices in a group
   */
  getGroupDevices(groupId: string): string[] {
    this.initialize();
    const db = this.getDb();

    const rows = db.prepare(`
      SELECT device_id FROM device_group_members WHERE group_id = ? ORDER BY added_at ASC
    `).all(groupId) as { device_id: string }[];

    return rows.map(r => r.device_id);
  }

  /**
   * Get groups a device belongs to
   */
  getDeviceGroups(deviceId: string): DeviceGroup[] {
    this.initialize();
    const db = this.getDb();

    const rows = db.prepare(`
      SELECT g.*, (SELECT COUNT(*) FROM device_group_members WHERE group_id = g.id) as device_count
      FROM device_groups g
      INNER JOIN device_group_members m ON g.id = m.group_id
      WHERE m.device_id = ?
      ORDER BY g.name ASC
    `).all(deviceId) as (GroupRow & { device_count: number })[];

    return rows.map(row => this.rowToGroup(row));
  }

  /**
   * Set device groups (replace all)
   */
  setDeviceGroups(deviceId: string, groupIds: string[]): void {
    this.initialize();
    const db = this.getDb();

    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM device_group_members WHERE device_id = ?').run(deviceId);

      const stmt = db.prepare(`
        INSERT INTO device_group_members (group_id, device_id, added_at) VALUES (?, ?, ?)
      `);

      const now = Date.now();
      for (const groupId of groupIds) {
        stmt.run(groupId, deviceId, now);
      }
    });

    transaction();
  }

  /**
   * Get group count
   */
  getGroupCount(): number {
    this.initialize();
    const db = this.getDb();

    const row = db.prepare('SELECT COUNT(*) as count FROM device_groups').get() as { count: number };
    return row.count;
  }

  /**
   * Clear all groups (for testing)
   */
  clear(): void {
    this.initialize();
    const db = this.getDb();
    db.prepare('DELETE FROM device_group_members').run();
    db.prepare('DELETE FROM device_groups').run();
  }

  private rowToGroup(row: GroupRow & { device_count?: number }): DeviceGroup {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      policyId: row.policy_id,
      parentGroupId: row.parent_group_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deviceCount: row.device_count,
    };
  }
}

export const groupStore = new GroupStore();
