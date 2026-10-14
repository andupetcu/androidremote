import { render, screen, waitFor, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { API_BASE } from '../utils/api';
import { DeviceApps } from '../components/device/DeviceApps';
import { DeviceCommands } from '../components/device/DeviceCommands';
import { closeAdminSocket } from '../lib/adminSocket';
import { effectiveProtectedPackages } from '../lib/deviceState';
import { isCommandSupported, ANDROID_COMMAND_TYPES } from '../lib/agentSupport';
import type { DeviceCommand } from '../types/api';

beforeEach(() => localStorage.setItem('auth_token', 'jwt'));
afterEach(() => {
  cleanup();
  localStorage.clear();
  closeAdminSocket();
});

const cmd = (id: string, status: string, packages: string[], createdAt: number) =>
  ({ id, deviceId: 'dev-1', type: 'SET_PROTECTED_PACKAGES', payload: { packages }, status, createdAt }) as unknown as DeviceCommand;
const tel = (protectedPackages: string[] | null, updatedAt: number) =>
  ({ protectedPackages, updatedAt }) as never;

describe('T18 protected packages come from telemetry', () => {
  it('uses telemetry when it reports the field, even an empty list', () => {
    expect(effectiveProtectedPackages(tel(['a.b'], 2000), [cmd('1', 'completed', ['x.y'], 1000)])).toEqual(['a.b']);
    expect(effectiveProtectedPackages(tel([], 2000), [cmd('1', 'completed', ['x.y'], 1000)])).toEqual([]);
  });

  it('falls back to the last command when telemetry lacks the field or is missing', () => {
    const commands = [cmd('1', 'completed', ['x.y'], 1000)];
    expect(effectiveProtectedPackages(tel(null, 2000), commands)).toEqual(['x.y']);
    expect(effectiveProtectedPackages(null, commands)).toEqual(['x.y']);
  });

  it('a live command issued after the telemetry report wins until the device reports again', () => {
    expect(effectiveProtectedPackages(tel(['a.b'], 1000), [cmd('1', 'pending', ['a.b', 'c.d'], 2000)])).toEqual(['a.b', 'c.d']);
    // a failed command never took effect
    expect(effectiveProtectedPackages(tel(['a.b'], 1000), [cmd('1', 'failed', ['z.z'], 2000)])).toEqual(['a.b']);
  });

  it('the Apps tab marks apps protected according to telemetry, not the stale command', async () => {
    const app = (pkg: string, name: string) => ({ packageName: pkg, appName: name, versionName: '1', versionCode: 1, installedAt: 1, updatedAt: 1, isSystemApp: false, enabled: true });
    server.use(
      http.get(`${API_BASE}/api/devices/dev-1/apps`, () => HttpResponse.json({ apps: [app('com.shop.pos', 'POS'), app('com.keep', 'Keep')], count: 2 })),
      http.get(`${API_BASE}/api/devices/dev-1/commands`, () => HttpResponse.json({ commands: [cmd('1', 'completed', ['com.keep'], 1000)] })),
      http.get(`${API_BASE}/api/devices/dev-1/telemetry`, () => HttpResponse.json({
        deviceId: 'dev-1', batteryLevel: 50, storageTotalBytes: 10, updatedAt: Date.now(), protectedPackages: ['com.shop.pos'],
      })),
    );
    render(<MemoryRouter><DeviceApps deviceId="dev-1" /></MemoryRouter>);
    const pos = (await screen.findByText('POS')).closest('tr') as HTMLElement;
    const keep = (await screen.findByText('Keep')).closest('tr') as HTMLElement;
    await waitFor(() => expect(within(pos).getByText(/^protected$/i)).toBeInTheDocument());
    expect(within(keep).queryByText(/^protected$/i)).not.toBeInTheDocument();
  });
});

describe('T18 commands the Android agent does not implement', () => {
  it('knows exactly what the agent dispatches', () => {
    for (const t of ['LOCK', 'REBOOT', 'WIPE', 'SYNC_POLICY', 'TAKE_SCREENSHOT', 'SET_VOLUME', 'SET_KIOSK', 'START_REMOTE'] as const) {
      expect(ANDROID_COMMAND_TYPES.has(t)).toBe(true);
    }
    for (const t of ['UNLOCK', 'SEND_MESSAGE', 'PLAY_SOUND', 'SET_BRIGHTNESS', 'RUN_SHELL', 'LIST_FILES', 'DOWNLOAD_FILE'] as const) {
      expect(isCommandSupported('android', t)).toBe(false);
      expect(isCommandSupported(undefined, t)).toBe(false); // devices without an OS are Android
      expect(isCommandSupported('windows', t)).toBe(true);
    }
  });

  function mockCommands() {
    server.use(http.get(`${API_BASE}/api/devices/dev-1/commands`, () => HttpResponse.json({ commands: [] })));
  }

  it('Play Sound is hidden (not rendered) for an Android device, with no hint text', async () => {
    mockCommands();
    render(<DeviceCommands deviceId="dev-1" osType="android" />);
    await screen.findByRole('button', { name: /^screenshot$/i });
    expect(screen.queryByRole('button', { name: /play sound/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/not supported by the android agent/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^screenshot$/i })).toBeEnabled();
  });

  it('Play Sound is hidden when the OS is unknown (treated as Android)', async () => {
    mockCommands();
    render(<DeviceCommands deviceId="dev-1" />);
    await screen.findByRole('button', { name: /^screenshot$/i });
    expect(screen.queryByRole('button', { name: /play sound/i })).not.toBeInTheDocument();
  });

  it('Play Sound stays available for a non-Android agent', async () => {
    mockCommands();
    render(<DeviceCommands deviceId="dev-1" osType="windows" />);
    expect(await screen.findByRole('button', { name: /play sound/i })).toBeEnabled();
  });
});
