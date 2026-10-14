import crypto from 'crypto';

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

function list(raw: string | undefined): string[] {
  return (raw || '').split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * ICE servers for one client (C7). Read from env at call time:
 *  - STUN_URLS: comma-separated (default: Google public STUN, which carries no credentials);
 *  - TURN_URLS + TURN_SECRET: coturn `use-auth-secret` REST credentials, username `<expiry>:<id>`,
 *    credential base64(HMAC-SHA1(secret, username)), valid TURN_TTL_SECONDS (default 3600).
 * TURN entries are omitted when either TURN_URLS or TURN_SECRET is unset. No credential lives in source.
 * `id` is the device ID or the admin subject, so coturn logs show who asked.
 */
export function buildIceServers(id: string, nowMs: number = Date.now()): IceServer[] {
  const configuredStun = list(process.env.STUN_URLS);
  const stun = configuredStun.length > 0 ? configuredStun : ['stun:stun.l.google.com:19302'];
  const servers: IceServer[] = [{ urls: stun }];

  const turnUrls = list(process.env.TURN_URLS);
  const secret = process.env.TURN_SECRET;
  if (turnUrls.length > 0 && secret) {
    const ttl = Number(process.env.TURN_TTL_SECONDS) > 0 ? Number(process.env.TURN_TTL_SECONDS) : 3600;
    const expiry = Math.floor(nowMs / 1000) + ttl;
    const username = `${expiry}:${id}`;
    const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
    servers.push({ urls: turnUrls, username, credential });
  }
  return servers;
}
