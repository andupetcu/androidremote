import { render, screen, waitFor, cleanup, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { API_BASE } from '../utils/api';
import { DeviceCard } from '../components/DeviceCard';
import { DevicesPage } from '../pages/DevicesPage';
import { GroupsPage } from '../pages/GroupsPage';
import { PoliciesPage } from '../pages/PoliciesPage';
import { Dashboard } from '../pages/Dashboard';
import { PairingFlow } from '../components/PairingFlow';
import { DeviceCommands } from '../components/device/DeviceCommands';
import { DeviceRemote } from '../components/device/DeviceRemote';
import { FakeWebSocket, installFakeWebSocket } from './fakeWebSocket';
import { closeAdminSocket } from '../lib/adminSocket';

vi.mock('../components/RemoteScreen', () => ({
  RemoteScreen: () => <div data-testid="remote-screen">remote screen</div>,
}));
vi.mock('../components/RelayRemoteScreen', () => ({ RelayRemoteScreen: () => null }));

const device = {
  id: 'dev-1', name: 'Pixel', model: 'P', androidVersion: '14', enrolledAt: 1, lastSeenAt: 2, status: 'online',
  osType: 'android', complianceStatus: 'compliant',
};

beforeEach(() => localStorage.setItem('auth_token', 'jwt'));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  closeAdminSocket();
});

const sources = import.meta.glob(['../**/*.{ts,tsx}', '!../tests/**'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

describe('no browser confirm() left (T5 follow-up)', () => {
  it('no source file calls window.confirm or bare confirm()', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    const offenders = Object.entries(sources)
      .filter(([, text]) => /(^|[^.\w])(window\.)?confirm\((?!\s*\{)/.test(text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')))
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  it('DeviceCard asks in-page before unenrolling', async () => {
    const native = vi.spyOn(window, 'confirm');
    const onUnenroll = vi.fn();
    const user = userEvent.setup();
    render(<MemoryRouter><DeviceCard device={device as never} onUnenroll={onUnenroll} /></MemoryRouter>);
    await user.click(screen.getByRole('button', { name: /remove/i }));
    expect(onUnenroll).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /unenroll/i }));
    expect(onUnenroll).toHaveBeenCalledWith('dev-1');
    expect(native).not.toHaveBeenCalled();
  });

  it('DevicesPage delete: cancel sends nothing, confirm sends DELETE', async () => {
    let deletes = 0;
    server.use(
      http.get(`${API_BASE}/api/devices`, () => HttpResponse.json({ devices: [device] })),
      http.delete(`${API_BASE}/api/devices/dev-1`, () => { deletes++; return HttpResponse.json({ success: true }); })
    );
    const user = userEvent.setup();
    render(<MemoryRouter><DevicesPage /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: /^delete$/i }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /cancel/i }));
    expect(deletes).toBe(0);
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /unenroll/i }));
    await waitFor(() => expect(deletes).toBe(1));
  });

  it('GroupsPage group delete uses the in-page dialog', async () => {
    let deletes = 0;
    server.use(
      http.get(`${API_BASE}/api/groups`, () => HttpResponse.json({ groups: [{ id: 'g1', name: 'Group One', description: null, parentId: null, policyId: null, createdAt: 1, updatedAt: 1, deviceCount: 0 }] })),
      http.delete(`${API_BASE}/api/groups/g1`, () => { deletes++; return HttpResponse.json({ success: true }); })
    );
    const native = vi.spyOn(window, 'confirm');
    const user = userEvent.setup();
    render(<MemoryRouter><GroupsPage /></MemoryRouter>);
    await screen.findByText('Group One');
    await user.click(screen.getByRole('button', { name: /delete/i }));
    expect(deletes).toBe(0);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /delete group/i }));
    await waitFor(() => expect(deletes).toBe(1));
    expect(native).not.toHaveBeenCalled();
  });

  it('PoliciesPage policy delete uses the in-page dialog', async () => {
    let deletes = 0;
    server.use(
      http.get(`${API_BASE}/api/policies`, () => HttpResponse.json({ policies: [{ id: 'p1', name: 'Policy One', description: null, isDefault: false, kioskMode: false, createdAt: 1, updatedAt: 1 }] })),
      http.delete(`${API_BASE}/api/policies/p1`, () => { deletes++; return HttpResponse.json({ success: true }); })
    );
    const native = vi.spyOn(window, 'confirm');
    const user = userEvent.setup();
    render(<MemoryRouter><PoliciesPage /></MemoryRouter>);
    await screen.findByText('Policy One');
    await user.click(screen.getByRole('button', { name: /delete/i }));
    expect(deletes).toBe(0);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /delete policy/i }));
    await waitFor(() => expect(deletes).toBe(1));
    expect(native).not.toHaveBeenCalled();
  });
});

describe('WIPE needs the device id typed (C10)', () => {
  it('keeps the confirm button disabled until the exact id is typed', async () => {
    const posted: unknown[] = [];
    server.use(
      http.get(`${API_BASE}/api/devices/dev-1/commands`, () => HttpResponse.json({ commands: [] })),
      http.post(`${API_BASE}/api/commands`, async ({ request }) => { posted.push(await request.json()); return HttpResponse.json({ command: { id: 'c', status: 'pending' } }, { status: 201 }); })
    );
    const user = userEvent.setup();
    render(<DeviceCommands deviceId="dev-1" />);
    await user.click(await screen.findByRole('button', { name: /wipe device/i }));
    const dialog = await screen.findByRole('dialog');
    const confirmBtn = within(dialog).getByRole('button', { name: /wipe device/i });
    expect(confirmBtn).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/type the device id/i), 'dev-2');
    expect(confirmBtn).toBeDisabled();
    await user.clear(within(dialog).getByLabelText(/type the device id/i));
    await user.type(within(dialog).getByLabelText(/type the device id/i), 'dev-1');
    expect(confirmBtn).toBeEnabled();
    expect(posted).toHaveLength(0);
  });
});

describe('PairingFlow uses the shared fetch wrapper (T5 follow-up)', () => {
  it('a rejected pairing code shows the error and does not log the admin out', async () => {
    localStorage.setItem('auth_token', 'jwt');
    const user = userEvent.setup();
    render(<PairingFlow />);
    await user.click(await screen.findByRole('button', { name: /enter code manually/i }));
    await user.type(screen.getByLabelText(/pairing code/i), '999999');
    await user.click(screen.getByRole('button', { name: /connect/i }));
    expect(await screen.findByText(/invalid code/i)).toBeInTheDocument();
    expect(localStorage.getItem('auth_token')).toBe('jwt');
  });

  it('initiate request goes through apiFetch (carries the bearer token)', async () => {
    let auth: string | null = 'unset';
    server.use(http.post('/api/pair/initiate', ({ request }) => {
      auth = request.headers.get('authorization');
      return HttpResponse.json({ pairingCode: '123456', qrCodeData: 'x', expiresAt: Date.now() + 60000 });
    }));
    render(<PairingFlow />);
    await screen.findByText(/123456/);
    expect(auth).toBe('Bearer jwt');
  });
});

describe('default MSW handler for /api/ice-servers (T7 follow-up)', () => {
  it('answers without a per-test override', async () => {
    const res = await fetch(`${API_BASE}/api/ice-servers`);
    const body = await res.json();
    expect(Array.isArray(body.iceServers)).toBe(true);
  });
});

describe('DeviceRemote (rest of WU-09)', () => {
  it('shows a failed START_REMOTE and never opens the remote screen', async () => {
    server.use(http.post(`${API_BASE}/api/devices/dev-1/commands`, () => HttpResponse.json({ error: 'device offline' }, { status: 409 })));
    const user = userEvent.setup();
    render(<DeviceRemote deviceId="dev-1" />);
    await user.click(screen.getByRole('button', { name: /connect/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/device offline/i);
    expect(screen.queryByTestId('remote-screen')).toBeNull();
    expect(screen.getByRole('button', { name: /connect|retry/i })).toBeInTheDocument();
  });

  it('opens the remote screen right after the command is accepted (no fixed 6 s sleep)', async () => {
    server.use(http.post(`${API_BASE}/api/devices/dev-1/commands`, () => HttpResponse.json({ command: { id: 'c1' } }, { status: 201 })));
    const user = userEvent.setup();
    render(<DeviceRemote deviceId="dev-1" />);
    const t0 = Date.now();
    await user.click(screen.getByRole('button', { name: /connect/i }));
    await screen.findByTestId('remote-screen', {}, { timeout: 2000 });
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it('sends START_REMOTE to the device commands endpoint exactly once per click', async () => {
    let posts = 0;
    server.use(http.post(`${API_BASE}/api/devices/dev-1/commands`, () => { posts++; return HttpResponse.json({ command: { id: 'c1' } }, { status: 201 }); }));
    const user = userEvent.setup();
    render(<DeviceRemote deviceId="dev-1" />);
    await user.click(screen.getByRole('button', { name: /connect/i }));
    await screen.findByTestId('remote-screen');
    expect(posts).toBe(1);
  });
});

describe('Dashboard debounces event-triggered refreshes (WU-16)', () => {
  it('a burst of device-online events (spread over a second) causes one device list refetch', async () => {
    installFakeWebSocket();
    let lists = 0;
    server.use(
      http.post(`${API_BASE}/api/ws-ticket`, () => HttpResponse.json({ ticket: 't', expiresAt: Date.now() + 60000 })),
      http.get(`${API_BASE}/api/devices`, () => { lists++; return HttpResponse.json({ devices: [device] }); }),
      http.get(`${API_BASE}/api/events`, () => HttpResponse.json({ events: [] }))
    );
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    await waitFor(() => expect(lists).toBe(1));
    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
    FakeWebSocket.instances[0].open();
    for (let i = 0; i < 8; i++) {
      act(() => {
        FakeWebSocket.instances[0].receive({
          type: 'device-event',
          event: { id: `e${i}`, deviceId: `d${i}`, eventType: 'device-online', severity: 'info', data: {}, acknowledged: false, createdAt: i },
        });
      });
      await new Promise((r) => setTimeout(r, 120)); // each request finishes before the next event
    }
    await new Promise((r) => setTimeout(r, 2800));
    expect(lists).toBe(2); // the initial load plus ONE debounced refresh, not 9
  }, 10000);
});
