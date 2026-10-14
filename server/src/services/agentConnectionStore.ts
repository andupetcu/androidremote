import { WebSocket } from 'ws';

export interface AgentConnection {
  ws: WebSocket;
  deviceId: string;
  agentVersion: string;
  os: string;
  arch: string;
  hostname: string;
  lastHeartbeat: number;
  activeSessions: Map<number, ViewerSession>;
  nextChannelId: number;
}

export interface ViewerSession {
  ws: WebSocket;
  channelId: number;
  sessionType: 'desktop' | 'terminal' | 'files';
  userId: string;
}

/**
 * In-memory store for connected relay agents (Linux/Windows).
 * Maps deviceId -> AgentConnection.
 */
class AgentConnectionStore {
  private connections = new Map<string, AgentConnection>();

  /**
   * Register a new agent connection
   */
  addAgent(
    deviceId: string,
    ws: WebSocket,
    info: { agentVersion: string; os: string; arch: string; hostname: string }
  ): AgentConnection {
    // Close existing connection if any
    const existing = this.connections.get(deviceId);
    if (existing) {
      for (const [, session] of existing.activeSessions) {
        try {
          session.ws.close(1000, 'agent reconnected');
        } catch {
          // ignore
        }
      }
      existing.activeSessions.clear();
      try {
        existing.ws.close(1000, 'replaced by new connection');
      } catch {
        // ignore
      }
    }

    const conn: AgentConnection = {
      ws,
      deviceId,
      agentVersion: info.agentVersion,
      os: info.os,
      arch: info.arch,
      hostname: info.hostname,
      lastHeartbeat: Date.now(),
      activeSessions: new Map(),
      nextChannelId: 1,
    };

    this.connections.set(deviceId, conn);
    return conn;
  }

  /**
   * Remove an agent connection
   */
  removeAgent(deviceId: string): void {
    const conn = this.connections.get(deviceId);
    if (conn) {
      // Close all viewer sessions
      for (const [, session] of conn.activeSessions) {
        try {
          session.ws.close(1000, 'agent disconnected');
        } catch {
          // ignore
        }
      }
      conn.activeSessions.clear();
      this.connections.delete(deviceId);
    }
  }

  /**
   * Revoke a device's relay presence now (unenroll): close the agent socket and every viewer, drop the state.
   * Returns true when an agent was registered.
   */
  disconnectDevice(deviceId: string, reason: string): boolean {
    const conn = this.connections.get(deviceId);
    if (!conn) return false;
    this.connections.delete(deviceId);
    for (const [, session] of conn.activeSessions) {
      try { session.ws.close(4004, reason); } catch { /* ignore */ }
    }
    conn.activeSessions.clear();
    try { conn.ws.close(4004, reason); } catch { /* ignore */ }
    return true;
  }

  /**
   * Remove the agent registration only when `ws` is the socket that owns it. A replaced socket
   * closes late; it must not tear down its successor (SR-05). Returns true when it removed.
   */
  removeAgentIfSocket(deviceId: string, ws: WebSocket): boolean {
    const conn = this.connections.get(deviceId);
    if (!conn || conn.ws !== ws) return false;
    this.removeAgent(deviceId);
    return true;
  }

  /** Total viewer sessions over all agents */
  getTotalSessionCount(): number {
    let n = 0;
    for (const [, conn] of this.connections) n += conn.activeSessions.size;
    return n;
  }

  /**
   * Get an agent connection by device ID
   */
  getAgent(deviceId: string): AgentConnection | undefined {
    return this.connections.get(deviceId);
  }

  /**
   * Check if an agent is connected
   */
  isAgentConnected(deviceId: string): boolean {
    const conn = this.connections.get(deviceId);
    return !!conn && conn.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Update heartbeat timestamp
   */
  updateHeartbeat(deviceId: string): void {
    const conn = this.connections.get(deviceId);
    if (conn) {
      conn.lastHeartbeat = Date.now();
    }
  }

  /**
   * Allocate a new channel for a viewer session
   */
  allocateChannel(
    deviceId: string,
    viewerWs: WebSocket,
    sessionType: 'desktop' | 'terminal' | 'files',
    userId: string
  ): number | null {
    const conn = this.connections.get(deviceId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      return null;
    }

    // Channel ids are u16 on the wire (0 is the control channel): recycle instead of overflowing
    let channelId = conn.nextChannelId;
    for (let tries = 0; tries < 65535 && (channelId === 0 || channelId > 0xffff || conn.activeSessions.has(channelId)); tries++) {
      channelId = channelId >= 0xffff ? 1 : channelId + 1;
    }
    if (conn.activeSessions.has(channelId)) return null;
    conn.nextChannelId = channelId >= 0xffff ? 1 : channelId + 1;
    const session: ViewerSession = {
      ws: viewerWs,
      channelId,
      sessionType,
      userId,
    };

    conn.activeSessions.set(channelId, session);
    return channelId;
  }

  /**
   * Remove a viewer session
   */
  removeSession(deviceId: string, channelId: number): void {
    const conn = this.connections.get(deviceId);
    if (conn) {
      conn.activeSessions.delete(channelId);
    }
  }

  /**
   * Find a viewer session by its WebSocket
   */
  findSessionByViewer(
    deviceId: string,
    viewerWs: WebSocket
  ): ViewerSession | undefined {
    const conn = this.connections.get(deviceId);
    if (!conn) return undefined;

    for (const [, session] of conn.activeSessions) {
      if (session.ws === viewerWs) {
        return session;
      }
    }
    return undefined;
  }

  /**
   * Get all connected agent device IDs
   */
  getConnectedDeviceIds(): string[] {
    return Array.from(this.connections.keys());
  }

  /**
   * Get count of connected agents
   */
  getConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Check for stale connections (no heartbeat within timeout)
   */
  cleanupStale(timeoutMs: number = 90000): string[] {
    const now = Date.now();
    const stale: string[] = [];

    for (const [deviceId, conn] of this.connections) {
      if (now - conn.lastHeartbeat > timeoutMs) {
        stale.push(deviceId);
        try {
          conn.ws.close(1000, 'heartbeat timeout');
        } catch {
          // ignore
        }
        this.removeAgent(deviceId);
      }
    }

    return stale;
  }
}

export const agentConnectionStore = new AgentConnectionStore();
