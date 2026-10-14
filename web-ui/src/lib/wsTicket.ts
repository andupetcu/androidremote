import { apiFetch, API_BASE } from '../utils/api';

export type WsTicketPurpose = 'signaling' | 'admin' | 'relay';

/**
 * Obtain a single-use, short-lived WebSocket ticket (contract C3).
 * The ticket, never the JWT, goes into the WebSocket URL.
 */
export async function fetchWsTicket(purpose: WsTicketPurpose, deviceId?: string): Promise<string> {
  const res = await apiFetch(`${API_BASE}/api/ws-ticket`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(deviceId ? { purpose, deviceId } : { purpose }),
  });
  if (!res.ok) throw new Error(`Could not get a ${purpose} connection ticket (${res.status})`);
  const data = (await res.json()) as { ticket?: string };
  if (!data.ticket) throw new Error('Server returned no connection ticket');
  return data.ticket;
}

/** Append `ticket=` (and optional extra params) to a ws(s) URL. */
export function buildWsUrl(base: string, ticket: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra);
  params.set('ticket', ticket);
  return `${base}${base.includes('?') ? '&' : '?'}${params.toString()}`;
}
