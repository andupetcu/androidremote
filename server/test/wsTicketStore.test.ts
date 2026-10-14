import { WsTicketStore } from '../src/services/wsTicketStore';

describe('WsTicketStore', () => {
  let now = 1_000_000;
  const store = () => new WsTicketStore({ ttlMs: 60_000, now: () => now });

  beforeEach(() => { now = 1_000_000; });

  it('issues a 64-hex-char ticket with expiry', () => {
    const s = store();
    const t = s.issue({ purpose: 'signaling', subject: 'admin', deviceId: 'dev-1' });
    expect(t.ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(t.expiresAt).toBe(now + 60_000);
  });

  it('consumes a ticket exactly once for the matching purpose', () => {
    const s = store();
    const { ticket } = s.issue({ purpose: 'signaling', subject: 'admin', deviceId: 'dev-1' });
    expect(s.consume(ticket, 'signaling')).toEqual({ purpose: 'signaling', subject: 'admin', deviceId: 'dev-1' });
    expect(s.consume(ticket, 'signaling')).toBeNull();
  });

  it('rejects a ticket used for another purpose and burns it', () => {
    const s = store();
    const { ticket } = s.issue({ purpose: 'admin', subject: 'admin' });
    expect(s.consume(ticket, 'signaling')).toBeNull();
    expect(s.consume(ticket, 'admin')).toBeNull();
  });

  it('rejects expired tickets', () => {
    const s = store();
    const { ticket } = s.issue({ purpose: 'relay', subject: 'admin', deviceId: 'd' });
    now += 60_001;
    expect(s.consume(ticket, 'relay')).toBeNull();
  });

  it('rejects unknown and malformed tickets', () => {
    const s = store();
    expect(s.consume('nope', 'signaling')).toBeNull();
    expect(s.consume(undefined as unknown as string, 'signaling')).toBeNull();
  });

  it('prunes expired tickets so memory stays bounded', () => {
    const s = store();
    for (let i = 0; i < 100; i++) s.issue({ purpose: 'admin', subject: 'admin' });
    now += 120_000;
    s.issue({ purpose: 'admin', subject: 'admin' });
    expect(s.size()).toBe(1);
  });
});
