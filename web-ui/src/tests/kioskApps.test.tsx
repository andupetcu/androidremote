import { render, screen, waitFor, cleanup, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { API_BASE } from '../utils/api';
import { DeviceKiosk } from '../components/device/DeviceKiosk';
import { DeviceApps } from '../components/device/DeviceApps';
import { closeAdminSocket } from '../lib/adminSocket';

beforeEach(() => localStorage.setItem('auth_token', 'jwt'));
afterEach(() => {
  cleanup();
  localStorage.clear();
  closeAdminSocket();
});

const app = (pkg: string, name: string, extra: Record<string, unknown> = {}) => ({
  packageName: pkg, appName: name, versionName: '1', versionCode: 1, installedAt: 1, updatedAt: 1,
  isSystemApp: false, enabled: true, ...extra,
});

function mockDevice(opts: { apps?: unknown[]; commands?: unknown[]; policy?: unknown } = {}) {
  const posted: Array<{ type: string; payload: Record<string, unknown>; deviceId: string }> = [];
  server.use(
    http.get(`${API_BASE}/api/devices/dev-1/apps`, () => HttpResponse.json({ apps: opts.apps ?? [], count: 0 })),
    http.get(`${API_BASE}/api/devices/dev-1/commands`, () => HttpResponse.json({ commands: opts.commands ?? [] })),
    http.get(`${API_BASE}/api/policies`, () => HttpResponse.json({ policies: opts.policy ? [opts.policy] : [] })),
    http.post(`${API_BASE}/api/commands`, async ({ request }) => {
      const body = (await request.json()) as (typeof posted)[number];
      posted.push(body);
      return HttpResponse.json({ command: { id: 'c-new', deviceId: 'dev-1', type: body.type, payload: body.payload, status: 'pending', createdAt: Date.now() } }, { status: 201 });
    })
  );
  return posted;
}

const cmd = (id: string, type: string, status: string, payload = {}, extra = {}) =>
  ({ id, deviceId: 'dev-1', type, payload, status, createdAt: 1000 + Number(id.replace(/\D/g, '') || 0), ...extra });

describe('Kiosk panel (WU-15, C10)', () => {
  const device = { id: 'dev-1', policyId: 'p1', complianceStatus: 'non_compliant' };
  const policy = { id: 'p1', name: 'Shop', kioskMode: true, kioskPackage: 'com.shop.pos' };

  it('sends SET_KIOSK {packageName, enabled, lockTask} for the chosen app', async () => {
    const posted = mockDevice({ apps: [app('com.shop.pos', 'POS'), app('com.other', 'Other')], policy });
    const user = userEvent.setup();
    render(<DeviceKiosk device={device as never} />);
    await user.selectOptions(await screen.findByLabelText(/kiosk app/i), 'com.shop.pos');
    expect(screen.getByLabelText(/lock task/i)).toBeChecked(); // default on
    await user.click(screen.getByRole('button', { name: /enable kiosk/i }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ deviceId: 'dev-1', type: 'SET_KIOSK', payload: { packageName: 'com.shop.pos', enabled: true, lockTask: true } });
    await user.click(screen.getByLabelText(/lock task/i));
    await user.click(screen.getByRole('button', { name: /enable kiosk/i }));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1].payload).toMatchObject({ lockTask: false });
  });

  it('disables kiosk with enabled:false', async () => {
    const posted = mockDevice({
      apps: [app('com.shop.pos', 'POS')],
      commands: [cmd('1', 'SET_KIOSK', 'completed', { packageName: 'com.shop.pos', enabled: true, lockTask: true })],
    });
    const user = userEvent.setup();
    render(<DeviceKiosk device={device as never} />);
    await user.click(await screen.findByRole('button', { name: /disable kiosk/i }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].payload).toMatchObject({ enabled: false });
  });

  it('shows the applied state from the latest SET_KIOSK command', async () => {
    mockDevice({
      apps: [app('com.shop.pos', 'POS')],
      commands: [
        cmd('2', 'SET_KIOSK', 'completed', { packageName: 'com.shop.pos', enabled: true, lockTask: true }),
        cmd('1', 'SET_KIOSK', 'failed', { packageName: 'com.old', enabled: true, lockTask: false }, { error: 'old failure' }),
      ],
    });
    render(<DeviceKiosk device={device as never} />);
    const status = await screen.findByTestId('kiosk-status');
    expect(status).toHaveTextContent(/applied/i);
    expect(status).toHaveTextContent('com.shop.pos');
    expect(status).toHaveTextContent(/lock task on/i);
  });

  it('shows a failed apply with the device error, and an in-flight one as pending', async () => {
    mockDevice({ commands: [cmd('2', 'SET_KIOSK', 'failed', { packageName: 'com.x', enabled: true, lockTask: false }, { error: 'not a device owner' })] });
    const { unmount } = render(<DeviceKiosk device={device as never} />);
    expect(await screen.findByTestId('kiosk-status')).toHaveTextContent(/failed.*not a device owner/i);
    unmount();
    mockDevice({ commands: [cmd('3', 'SET_KIOSK', 'executing', { packageName: 'com.x', enabled: true, lockTask: false })] });
    render(<DeviceKiosk device={device as never} />);
    expect(await screen.findByTestId('kiosk-status')).toHaveTextContent(/applying|executing/i);
  });

  it('shows policy-applied state, the last SYNC_POLICY result and the effective boot app', async () => {
    mockDevice({
      policy,
      commands: [cmd('4', 'SYNC_POLICY', 'failed', {}, { error: 'policy too large' })],
    });
    render(<DeviceKiosk device={device as never} />);
    const policyBox = await screen.findByTestId('policy-status');
    expect(policyBox).toHaveTextContent(/non.compliant/i);
    expect(policyBox).toHaveTextContent(/policy too large/i);
    expect(policyBox).toHaveTextContent('com.shop.pos');
  });

  it('shows the error when the server rejects the command', async () => {
    mockDevice({ apps: [app('com.shop.pos', 'POS')] });
    server.use(http.post(`${API_BASE}/api/commands`, () => HttpResponse.json({ error: 'unknown command type' }, { status: 400 })));
    const user = userEvent.setup();
    render(<DeviceKiosk device={device as never} />);
    await user.selectOptions(await screen.findByLabelText(/kiosk app/i), 'com.shop.pos');
    await user.click(screen.getByRole('button', { name: /enable kiosk/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/unknown command type/i);
  });
});

describe('App management actions (WU-15, C10)', () => {
  const apps = [app('com.shop.pos', 'POS'), app('com.old.app', 'Old', { enabled: false })];

  function renderApps() {
    return render(<MemoryRouter><DeviceApps deviceId="dev-1" /></MemoryRouter>);
  }
  const rowFor = async (name: string) => (await screen.findByText(name)).closest('tr') as HTMLElement;

  it('Launch sends LAUNCH_APP without a prompt', async () => {
    const posted = mockDevice({ apps });
    const user = userEvent.setup();
    renderApps();
    await user.click(within(await rowFor('POS')).getByRole('button', { name: /launch/i }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ type: 'LAUNCH_APP', payload: { packageName: 'com.shop.pos' } });
  });

  it('Disable asks first, then sends DISABLE_APP; Enable sends ENABLE_APP', async () => {
    const posted = mockDevice({ apps });
    const user = userEvent.setup();
    renderApps();
    await user.click(within(await rowFor('POS')).getByRole('button', { name: /^disable$/i }));
    expect(posted).toHaveLength(0);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /disable app/i }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ type: 'DISABLE_APP', payload: { packageName: 'com.shop.pos' } });
    await user.click(within(await rowFor('Old')).getByRole('button', { name: /^enable$/i }));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toMatchObject({ type: 'ENABLE_APP', payload: { packageName: 'com.old.app' } });
  });

  it('Permissions dialog sends GRANT_PERMISSION with the chosen state', async () => {
    const posted = mockDevice({ apps });
    const user = userEvent.setup();
    renderApps();
    await user.click(within(await rowFor('POS')).getByRole('button', { name: /permissions/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/permission/i), { target: { value: 'android.permission.CAMERA' } });
    await user.selectOptions(within(dialog).getByLabelText(/state/i), 'denied');
    await user.click(within(dialog).getByRole('button', { name: /apply/i }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      type: 'GRANT_PERMISSION',
      payload: { packageName: 'com.shop.pos', permission: 'android.permission.CAMERA', state: 'denied' },
    });
  });

  it('Protect sends the full SET_PROTECTED_PACKAGES list; protected apps cannot be disabled from the UI', async () => {
    const posted = mockDevice({
      apps,
      commands: [cmd('1', 'SET_PROTECTED_PACKAGES', 'completed', { packages: ['com.keep'] })],
    });
    const user = userEvent.setup();
    renderApps();
    await user.click(within(await rowFor('POS')).getByRole('button', { name: /^protect$/i }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ type: 'SET_PROTECTED_PACKAGES' });
    expect((posted[0].payload.packages as string[]).sort()).toEqual(['com.keep', 'com.shop.pos']);
  });

  it('a protected app shows Protected, its Disable button is off, and Unprotect asks first', async () => {
    const posted = mockDevice({
      apps,
      commands: [cmd('1', 'SET_PROTECTED_PACKAGES', 'completed', { packages: ['com.shop.pos'] })],
    });
    const user = userEvent.setup();
    renderApps();
    const row = await rowFor('POS');
    await waitFor(() => expect(within(row).getByRole('button', { name: /^disable$/i })).toBeDisabled());
    expect(within(row).getByText(/protected/i)).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: /unprotect/i }));
    expect(posted).toHaveLength(0);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /unprotect/i }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].payload).toEqual({ packages: [] });
  });

  it('shows the server error when an action is rejected', async () => {
    mockDevice({ apps });
    server.use(http.post(`${API_BASE}/api/commands`, () => HttpResponse.json({ error: 'package is protected' }, { status: 409 })));
    const user = userEvent.setup();
    renderApps();
    await user.click(within(await rowFor('POS')).getByRole('button', { name: /launch/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/package is protected/i);
  });
});
