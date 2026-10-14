import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderHook } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { API_BASE } from '../utils/api';
import { SettingsPage } from '../pages/SettingsPage';
import { useMdmCommands } from '../hooks/useMdmCommands';

beforeEach(() => localStorage.setItem('auth_token', 'jwt'));
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

describe('T14 WIPE_DEVICE carries confirm (C10)', () => {
  it('sends confirm = deviceId and keeps wipeExternalStorage', async () => {
    const sendCommandWithResponse = vi.fn().mockResolvedValue({});
    const { result } = renderHook(() => useMdmCommands({ sendCommand: vi.fn(), sendCommandWithResponse }, 'dev-42'));
    await result.current.wipeDevice(true);
    expect(sendCommandWithResponse).toHaveBeenCalledWith({ type: 'WIPE_DEVICE', confirm: 'dev-42', wipeExternalStorage: true });
  });
  it('refuses to send without a device id', async () => {
    const sendCommandWithResponse = vi.fn();
    const { result } = renderHook(() => useMdmCommands({ sendCommand: vi.fn(), sendCommandWithResponse }));
    await expect(result.current.wipeDevice()).rejects.toThrow();
    expect(sendCommandWithResponse).not.toHaveBeenCalled();
  });
});

describe('T14 Settings QR uses /api/provisioning/info', () => {
  const payload = {
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME': 'com.androidremote.app/.admin.DeviceOwnerReceiver',
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION': 'https://mdm.example.test/api/provisioning/agent.apk',
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_CHECKSUM': 'abc_DEF-checksum',
    'android.app.extra.PROVISIONING_SKIP_EDUCATION_SCREENS': true,
    'android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED': true,
  };
  function stub(available: boolean, seen: { auth: string | null }) {
    server.use(
      http.get(`${API_BASE}/api/settings`, () => HttpResponse.json({})),
      http.get(`${API_BASE}/api/enroll/tokens`, () => HttpResponse.json({ tokens: [] })),
      http.get(`${API_BASE}/api/provisioning/info`, ({ request }) => {
        seen.auth = request.headers.get('authorization');
        return HttpResponse.json(available
          ? { available: true, packageName: 'com.androidremote.app', downloadUrl: 'https://mdm.example.test/api/provisioning/agent.apk', sha256: 'aa', checksum: 'abc_DEF-checksum', qrPayload: payload }
          : { available: false, packageName: 'com.androidremote.app', downloadUrl: 'https://mdm.example.test/api/provisioning/agent.apk', sha256: null, checksum: null, qrPayload: null });
      }),
    );
  }

  it('builds the QR JSON from the server payload (public URL, base64url checksum)', async () => {
    const seen = { auth: null as string | null };
    stub(true, seen);
    const clip = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: clip }, configurable: true });
    render(<SettingsPage />);
    const copy = await screen.findByRole('button', { name: /copy json/i });
    await waitFor(() => expect(copy).toBeEnabled());
    await userEvent.click(copy);
    const json = JSON.parse(clip.mock.calls[0][0]);
    expect(json['android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION']).toBe('https://mdm.example.test/api/provisioning/agent.apk');
    expect(json['android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_CHECKSUM']).toBe('abc_DEF-checksum');
    expect(JSON.stringify(json)).not.toContain('/api/uploads');
    expect(seen.auth).toBe('Bearer jwt');
  });

  it('says so when no agent APK has been uploaded', async () => {
    stub(false, { auth: null });
    render(<SettingsPage />);
    expect(await screen.findByText(/no agent apk has been uploaded/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy json/i })).toBeDisabled();
  });
});

import { DeviceApps } from '../components/device/DeviceApps';
import { DeviceKiosk } from '../components/device/DeviceKiosk';
import { MemoryRouter } from 'react-router-dom';
import { closeAdminSocket } from '../lib/adminSocket';
import { CommandHelpers } from '../hooks/useCommands';

describe('T14 app inventory uses the server field name `enabled`', () => {
  afterEach(() => closeAdminSocket());
  it('shows Enable for an app the server reports as enabled:false', async () => {
    server.use(
      http.get(`${API_BASE}/api/devices/dev-1/apps`, () => HttpResponse.json({
        apps: [
          { deviceId: 'dev-1', packageName: 'com.off', appName: 'Off', versionName: '1', versionCode: 1, installedAt: 1, updatedAt: 1, isSystemApp: false, enabled: false },
          { deviceId: 'dev-1', packageName: 'com.on', appName: 'On', versionName: '1', versionCode: 1, installedAt: 1, updatedAt: 1, isSystemApp: false, enabled: true },
        ], count: 2,
      })),
      http.get(`${API_BASE}/api/devices/dev-1/commands`, () => HttpResponse.json({ commands: [] })),
    );
    render(<MemoryRouter><DeviceApps deviceId="dev-1" /></MemoryRouter>);
    const offRow = (await screen.findByText('Off')).closest('tr')!;
    expect(offRow.textContent).toMatch(/Enable/);
    expect(offRow.textContent).not.toMatch(/Disable/);
    const onRow = screen.getByText('On').closest('tr')!;
    expect(onRow.textContent).toMatch(/Disable/);
  });
});

describe('T14 kiosk panel shows what the device reports in telemetry', () => {
  afterEach(() => closeAdminSocket());
  it('renders kioskActive / kioskPackage / lockTask from GET /telemetry', async () => {
    server.use(
      http.get(`${API_BASE}/api/devices/dev-1/apps`, () => HttpResponse.json({ apps: [], count: 0 })),
      http.get(`${API_BASE}/api/devices/dev-1/commands`, () => HttpResponse.json({ commands: [] })),
      http.get(`${API_BASE}/api/policies`, () => HttpResponse.json({ policies: [] })),
      http.get(`${API_BASE}/api/devices/dev-1/telemetry`, () => HttpResponse.json({
        deviceId: 'dev-1', batteryLevel: 50, storageTotalBytes: 10, updatedAt: Date.now(),
        kioskActive: true, kioskPackage: 'com.shop.player', lockTask: true, protectedPackages: ['com.a.b'],
      })),
    );
    render(<DeviceKiosk device={{ id: 'dev-1', policyId: null, complianceStatus: 'compliant' } as never} />);
    const reported = await screen.findByTestId('kiosk-reported');
    await waitFor(() => expect(reported.textContent).toMatch(/com\.shop\.player/));
    expect(reported.textContent).toMatch(/active/i);
    expect(reported.textContent).toMatch(/lock task on/i);
  });
});

describe('T14 wipe helper sends the flag the device reads', () => {
  it('maps its option to wipeExternalStorage, not an ignored flag', async () => {
    const sent: Array<[string, Record<string, unknown>]> = [];
    const send = (async (t: string, p: Record<string, unknown>) => { sent.push([t, p]); return {} as never; }) as never;
    await CommandHelpers.wipe(send, 'dev-9', true);
    expect(sent[0]).toEqual(['WIPE', { confirm: 'dev-9', wipeExternalStorage: true }]);
  });
});
