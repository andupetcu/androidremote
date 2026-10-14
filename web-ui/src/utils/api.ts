/**
 * Authenticated fetch wrapper.
 * Automatically attaches the JWT Bearer token and handles 401 responses
 * by clearing the token and redirecting to /login.
 */

export const API_BASE = import.meta.env.DEV ? 'http://localhost:7899' : '';

export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const token = localStorage.getItem('auth_token');
  const headers = new Headers(init?.headers);

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(input, { ...init, headers });

  // /api/auth/* and /api/pair/* answer 401 for bad credentials/codes: not a session expiry
  if (res.status === 401 && !input.includes('/api/auth/') && !input.includes('/api/pair/')) {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_username');
    window.location.href = '/login';
  }

  return res;
}
