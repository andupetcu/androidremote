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
