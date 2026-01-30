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

    const channelId = conn.nextChannelId++;
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
