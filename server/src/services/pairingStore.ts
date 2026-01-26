import crypto from 'crypto';

export interface PairingSession {
  deviceId: string;
  devicePublicKey: string;
  pairingCode: string;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'paired' | 'expired';
  controllerPublicKey?: string;
  sessionToken?: string;
}

class PairingStore {
  private sessions: Map<string, PairingSession> = new Map();
  private codeToDeviceId: Map<string, string> = new Map();
  private readonly CODE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

  generateDeviceId(): string {
    return `device-${crypto.randomBytes(8).toString('hex')}`;
  }

  generatePairingCode(): string {
    // Generate 6-digit code, ensuring uniqueness
    let code: string;
    do {
      code = Math.floor(100000 + Math.random() * 900000).toString();
    } while (this.codeToDeviceId.has(code));
    return code;
  }

  generateSessionToken(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  createSession(devicePublicKey: string): PairingSession {
    const deviceId = this.generateDeviceId();
    const pairingCode = this.generatePairingCode();
    const now = Date.now();

    const session: PairingSession = {
      deviceId,
      devicePublicKey,
      pairingCode,
      createdAt: now,
      expiresAt: now + this.CODE_EXPIRY_MS,
      status: 'pending',
    };

    this.sessions.set(deviceId, session);
    this.codeToDeviceId.set(pairingCode, deviceId);

    return session;
  }

  getSessionByDeviceId(deviceId: string): PairingSession | undefined {
    const session = this.sessions.get(deviceId);
    if (session && session.status === 'pending' && Date.now() > session.expiresAt) {
      session.status = 'expired';
    }
    return session;
  }

  getSessionByCode(pairingCode: string): PairingSession | undefined {
    const deviceId = this.codeToDeviceId.get(pairingCode);
    if (!deviceId) return undefined;
    const session = this.getSessionByDeviceId(deviceId);
    // Also check expiry for code-based lookup
    if (session && session.status === 'pending' && Date.now() > session.expiresAt) {
      session.status = 'expired';
    }
    return session;
  }

  completeSession(
    pairingCode: string,
    controllerPublicKey: string
  ): PairingSession | null {
    const session = this.getSessionByCode(pairingCode);

    if (!session) return null;
    if (session.status !== 'pending') return null;
    if (Date.now() > session.expiresAt) {
      session.status = 'expired';
      return null;
    }

    session.status = 'paired';
    session.controllerPublicKey = controllerPublicKey;
    session.sessionToken = this.generateSessionToken();

    // Remove code from lookup to prevent reuse
    this.codeToDeviceId.delete(pairingCode);

    return session;
  }

  expireSession(deviceId: string): void {
    const session = this.sessions.get(deviceId);
    if (session) {
      session.status = 'expired';
      session.expiresAt = Date.now() - 1;
      // Don't delete the code - keep it so we can tell users the code expired
      // Code is only deleted on successful completion (in completeSession)
    }
  }

  clear(): void {
    this.sessions.clear();
    this.codeToDeviceId.clear();
  }
}

export const pairingStore = new PairingStore();
