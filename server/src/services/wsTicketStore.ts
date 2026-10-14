import crypto from 'crypto';

/**
 * Short-lived, single-use tickets for browser WebSocket upgrades (contract C3 in docs/fix-plan/BRIEF.md).
 * The browser obtains a ticket with its admin JWT over HTTPS, then opens `/ws?ticket=…`, `/admin?ticket=…`
 * or `/relay?ticket=…`. Tickets never carry the JWT itself, expire after `ttlMs` and are burned on first use.
 * In-memory by design: a server restart only invalidates tickets that were valid for at most a minute.
 */
export type TicketPurpose = 'signaling' | 'admin' | 'relay';

export interface TicketClaims {
  purpose: TicketPurpose;
  subject: string;
  deviceId?: string;
}

interface Entry extends TicketClaims {
  expiresAt: number;
}

export class WsTicketStore {
  private readonly tickets = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  issue(claims: TicketClaims): { ticket: string; expiresAt: number } {
    this.prune();
    const ticket = crypto.randomBytes(32).toString('hex');
    const expiresAt = this.now() + this.ttlMs;
    this.tickets.set(ticket, { ...claims, expiresAt });
    return { ticket, expiresAt };
  }

  /** Returns the claims and burns the ticket, or null when unknown, expired or issued for another purpose. */
  consume(ticket: string, purpose: TicketPurpose): TicketClaims | null {
    if (typeof ticket !== 'string' || !/^[0-9a-f]{64}$/.test(ticket)) return null;
    const entry = this.tickets.get(ticket);
    if (!entry) return null;
    this.tickets.delete(ticket);
    if (entry.purpose !== purpose || entry.expiresAt < this.now()) return null;
    const { expiresAt: _expiresAt, ...claims } = entry;
    return claims;
  }

  size(): number {
    return this.tickets.size;
  }

  private prune(): void {
    const t = this.now();
    for (const [k, v] of this.tickets) {
      if (v.expiresAt < t) this.tickets.delete(k);
    }
  }
}

export const wsTicketStore = new WsTicketStore();
