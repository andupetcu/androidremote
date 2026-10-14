import { render, screen, waitFor, cleanup, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { API_BASE } from '../utils/api';
import { EnrollmentModal } from '../components/EnrollmentModal';
import { DeviceCommands } from '../components/device/DeviceCommands';
import { InstallApkModal } from '../components/apps/InstallApkModal';
import { AuthProvider } from '../hooks/AuthProvider';
import { useAuth } from '../hooks/useAuth';
import { FakeWebSocket, installFakeWebSocket } from './fakeWebSocket';
import { closeAdminSocket } from '../lib/adminSocket';

const JWT = 'jwt-abc';

beforeEach(() => localStorage.setItem('auth_token', JWT));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('EnrollmentModal sends Authorization (WU-01)', () => {
  it('POST and GET /api/enroll/tokens carry the bearer token', async () => {
    const seen: Array<{ method: string; auth: string | null }> = [];
    server.use(
      http.post(`${API_BASE}/api/enroll/tokens`, ({ request }) => {
        seen.push({ method: 'POST', auth: request.headers.get('authorization') });
        return HttpResponse.json({ id: '1', token: 'ABC', expiresAt: Date.now() + 1e6, maxUses: 1, usedCount: 0, status: 'active' });
      }),
      http.get(`${API_BASE}/api/enroll/tokens`, ({ request }) => {
        seen.push({ method: 'GET', auth: request.headers.get('authorization') });
        return HttpResponse.json({ tokens: [] });
      })
    );
    const user = userEvent.setup();
    render(<EnrollmentModal isOpen onClose={() => {}} onSuccess={() => {}} />);
    await user.click(screen.getByRole('button', { name: /generate token/i }));
    await waitFor(() => expect(seen.some((s) => s.method === 'POST')).toBe(true));
    expect(seen.find((s) => s.method === 'POST')!.auth).toBe(`Bearer ${JWT}`);
    await waitFor(() => expect(seen.some((s) => s.method === 'GET')).toBe(true), { timeout: 4000 });
    expect(seen.find((s) => s.method === 'GET')!.auth).toBe(`Bearer ${JWT}`);
  });

  it('deploy tab POST carries the bearer token', async () => {
    let auth: string | null = null;
    server.use(
      http.post(`${API_BASE}/api/enroll/tokens`, ({ request }) => {
        auth = request.headers.get('authorization');
        return HttpResponse.json({ id: '1', token: 'DEP', expiresAt: Date.now() + 1e6, maxUses: 10, usedCount: 0, status: 'active' });
      })
    );
    const user = userEvent.setup();
    render(<EnrollmentModal isOpen onClose={() => {}} onSuccess={() => {}} />);
    await user.click(screen.getByRole('button', { name: /deploy/i }));
    await user.click(await screen.findByRole('button', { name: /generate/i }));
    await waitFor(() => expect(auth).toBe(`Bearer ${JWT}`));
  });
});

function commandHandlers(opts: { commands?: unknown[]; onPost?: (b: Record<string, unknown>) => Response | undefined }) {
  const posted: Array<Record<string, unknown>> = [];
  server.use(
    http.get(`${API_BASE}/api/devices/dev-1/commands`, () => HttpResponse.json({ commands: opts.commands ?? [] })),
    http.post(`${API_BASE}/api/commands`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      posted.push(body);
      const custom = opts.onPost?.(body);
      if (custom) return custom;
      return HttpResponse.json({ command: { id: 'c1', deviceId: 'dev-1', type: body.type, status: 'pending', createdAt: 1, payload: {} } });
    })
  );
  return posted;
}

describe('DeviceCommands (WU-13)', () => {
  it('reboot needs in-page confirmation and sends nothing until confirmed', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const posted = commandHandlers({});
    const user = userEvent.setup();
    render(<DeviceCommands deviceId="dev-1" />);
    await user.click(await screen.findByRole('button', { name: /^reboot$/i }));
    const dialog = await screen.findByRole('dialog');
    expect(posted).toHaveLength(0);
    expect(confirmSpy).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
    expect(posted).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /^reboot$/i }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^reboot$/i }));
    await waitFor(() => expect(posted).toEqual([expect.objectContaining({ type: 'REBOOT', deviceId: 'dev-1' })]));
  });

  it('lock also needs confirmation', async () => {
    const posted = commandHandlers({});
    const user = userEvent.setup();
    render(<DeviceCommands deviceId="dev-1" />);
    await user.click(await screen.findByRole('button', { name: /lock device/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(posted).toHaveLength(0);
  });

  it('wipe sends the device id as confirm payload after confirmation', async () => {
    const posted = commandHandlers({});
    const user = userEvent.setup();
    render(<DeviceCommands deviceId="dev-1" />);
    await user.click(await screen.findByRole('button', { name: /wipe device/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/type the device id/i), 'dev-1');
    await user.click(within(dialog).getByRole('button', { name: /wipe device/i }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ type: 'WIPE', payload: expect.objectContaining({ confirm: 'dev-1' }) });
  });

  it('shows the server error when a command is rejected', async () => {
    commandHandlers({ onPost: () => HttpResponse.json({ error: 'device not found' }, { status: 404 }) });
    const user = userEvent.setup();
    render(<DeviceCommands deviceId="dev-1" />);
    await user.click(await screen.findByRole('button', { name: /get location/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/device not found/i);
  });

  it('shows every lifecycle state including expired, and the error text of a failed command', async () => {
    const mk = (id: string, status: string, error?: string) => ({ id, deviceId: 'dev-1', type: 'REBOOT', status, createdAt: 1, payload: {}, error });
    commandHandlers({
      commands: [
        mk('1', 'pending'), mk('2', 'delivered'), mk('3', 'executing'),
        mk('4', 'completed'), mk('5', 'failed', 'package signature mismatch'), mk('6', 'expired'),
      ],
    });
    render(<DeviceCommands deviceId="dev-1" />);
    for (const s of ['pending', 'delivered', 'executing', 'completed', 'failed', 'expired']) {
      expect(await screen.findByText(s)).toBeInTheDocument();
    }
    expect(screen.getByText(/package signature mismatch/)).toBeInTheDocument();
  });
});

describe('InstallApkModal (WU-14)', () => {
  const pkg = { packageName: 'com.x.app', appName: 'X', versionName: '1', fileSize: 10 } as never;

  function setup(installStatus: () => string) {
    const posted: Array<Record<string, unknown>> = [];
    server.use(
      http.get(`${API_BASE}/api/devices`, () =>
        HttpResponse.json({ devices: [{ id: 'dev-1', name: 'Tab 1', model: 'm', status: 'online' }, { id: 'dev-2', name: 'Tab 2', model: 'm', status: 'offline' }] })
      ),
      http.get(`${API_BASE}/api/devices/dev-1/commands`, () =>
        HttpResponse.json({ commands: [{ id: 'inst-1', deviceId: 'dev-1', type: 'INSTALL_APK', status: installStatus(), createdAt: 1, payload: {}, error: installStatus() === 'failed' ? 'hash mismatch' : undefined }] })
      ),
      http.post(`${API_BASE}/api/commands`, async ({ request }) => {
        posted.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ command: { id: 'r1' } });
      })
    );
    const onInstall = vi.fn().mockResolvedValue({ commands: [{ id: 'inst-1', deviceId: 'dev-1', type: 'INSTALL_APK' }] });
    return { posted, onInstall };
  }

  it('flags offline devices as queued', async () => {
    const { onInstall } = setup(() => 'pending');
    render(<InstallApkModal open onClose={() => {}} pkg={pkg} onInstall={onInstall} />);
    expect(await screen.findByText(/will run when the device reconnects/i)).toBeInTheDocument();
  });

  it('does not queue REBOOT until the install reports completed', async () => {
    let status = 'executing';
    const { posted, onInstall } = setup(() => status);
    const user = userEvent.setup();
    render(<InstallApkModal open onClose={() => {}} pkg={pkg} onInstall={onInstall} pollIntervalMs={20} />);
    await user.click(await screen.findByLabelText(/tab 1/i));
    await user.click(screen.getByLabelText(/reboot device after install/i));
    await user.click(screen.getByRole('button', { name: /install on 1 device/i }));
    await waitFor(() => expect(onInstall).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 150));
    expect(posted).toHaveLength(0);
    status = 'completed';
    await waitFor(() => expect(posted).toEqual([expect.objectContaining({ type: 'REBOOT', deviceId: 'dev-1' })]));
  });

  it('never reboots when the install fails and shows the error', async () => {
    const { posted, onInstall } = setup(() => 'failed');
    const user = userEvent.setup();
    render(<InstallApkModal open onClose={() => {}} pkg={pkg} onInstall={onInstall} pollIntervalMs={20} />);
    await user.click(await screen.findByLabelText(/tab 1/i));
    await user.click(screen.getByLabelText(/reboot device after install/i));
    await user.click(screen.getByRole('button', { name: /install on 1 device/i }));
    expect(await screen.findByText(/hash mismatch/i)).toBeInTheDocument();
    expect(posted).toHaveLength(0);
  });

  it('reboot is off by default', async () => {
    const { onInstall } = setup(() => 'pending');
    render(<InstallApkModal open onClose={() => {}} pkg={pkg} onInstall={onInstall} />);
    expect(await screen.findByLabelText(/reboot device after install/i)).not.toBeChecked();
  });
});

describe('logout (WU-18)', () => {
  function LogoutProbe() {
    const { logout } = useAuth();
    return <button onClick={logout}>out</button>;
  }

  it('calls the server, clears all stored state and closes the admin socket', async () => {
    installFakeWebSocket();
    const { acquireAdminSocket } = await import('../lib/adminSocket');
    let auth: string | null = null;
    server.use(
      http.get(`${API_BASE}/api/auth/verify`, () => HttpResponse.json({ ok: true })),
      http.post(`${API_BASE}/api/ws-ticket`, () => HttpResponse.json({ ticket: 't', expiresAt: Date.now() + 6e4 })),
      http.post(`${API_BASE}/api/auth/logout`, ({ request }) => {
        auth = request.headers.get('authorization');
        return HttpResponse.json({ ok: true });
      })
    );
    localStorage.setItem('auth_username', 'admin');
    localStorage.setItem('other_cache', 'x');
    sessionStorage.setItem('cache', 'y');
    const user = userEvent.setup();
    render(<AuthProvider><LogoutProbe /></AuthProvider>);
    acquireAdminSocket();
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    await user.click(screen.getByText('out'));
    await waitFor(() => expect(auth).toBe(`Bearer ${JWT}`));
    expect(localStorage.getItem('auth_token')).toBeNull();
    expect(localStorage.getItem('auth_username')).toBeNull();
    expect(localStorage.getItem('other_cache')).toBeNull();
    expect(sessionStorage.length).toBe(0);
    expect(FakeWebSocket.instances[0].readyState).toBe(3);
    closeAdminSocket();
    await act(async () => {});
  });
});
