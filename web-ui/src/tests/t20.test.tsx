import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { API_BASE } from '../utils/api';
import { DeviceRemote } from '../components/device/DeviceRemote';
import { RemoteScreen } from '../components/RemoteScreen';
import { closeAdminSocket } from '../lib/adminSocket';
import { ROOT_REQUIRED_MESSAGE } from '../lib/agentSupport';

const mockUseWebRTC = vi.fn();
vi.mock('../hooks/useWebRTC', () => ({ useWebRTC: (...a: unknown[]) => mockUseWebRTC(...a) }));

beforeEach(() => localStorage.setItem('auth_token', 'jwt'));
afterEach(() => { cleanup(); localStorage.clear(); closeAdminSocket(); });

function telemetry(rooted?: boolean) {
  server.use(http.get(`${API_BASE}/api/devices/dev-1/telemetry`, () => HttpResponse.json({
    deviceId: 'dev-1', batteryLevel: 50, storageTotalBytes: 10, storageUsedBytes: 1, ...(rooted === undefined ? {} : { rooted }),
  })));
}

describe('T20 remote desktop is root-only on Android', () => {
  it('disables Connect with visible text when the device reports rooted=false', async () => {
    telemetry(false);
    render(<DeviceRemote deviceId="dev-1" osType="android" />);
    expect(await screen.findByText(ROOT_REQUIRED_MESSAGE)).toBeVisible();
    expect(screen.getByRole('button', { name: /connect/i })).toBeDisabled();
  });

  it('allows Connect when rooted=true', async () => {
    telemetry(true);
    render(<DeviceRemote deviceId="dev-1" osType="android" />);
    await screen.findByRole('button', { name: /connect/i });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole('button', { name: /connect/i })).toBeEnabled();
    expect(screen.queryByText(ROOT_REQUIRED_MESSAGE)).toBeNull();
  });

  it('allows Connect when rooted is unknown', async () => {
    telemetry(undefined);
    render(<DeviceRemote deviceId="dev-1" />);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole('button', { name: /connect/i })).toBeEnabled();
    expect(screen.queryByText(ROOT_REQUIRED_MESSAGE)).toBeNull();
  });

  it('shows the root message when START_REMOTE fails saying root is required', async () => {
    telemetry(undefined);
    server.use(http.post(`${API_BASE}/api/devices/dev-1/commands`, () => HttpResponse.json({ error: 'root_required' }, { status: 409 })));
    const user = userEvent.setup();
    render(<DeviceRemote deviceId="dev-1" />);
    await user.click(screen.getByRole('button', { name: /connect/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(ROOT_REQUIRED_MESSAGE);
  });

  it('shows the root message for CAPTURE_FAILED root_required, not a generic capture error', () => {
    mockUseWebRTC.mockReturnValue({
      connectionState: 'connected', dataChannel: { onmessage: null }, error: null, sendCommand: vi.fn(), disconnect: vi.fn(),
      screenInfo: null, captureError: 'root_required', subscribeVideo: vi.fn(() => () => {}), requestKeyframe: vi.fn(),
    });
    render(<RemoteScreen deviceId="d" signalingUrl="ws://t/ws" />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(ROOT_REQUIRED_MESSAGE);
    expect(alert).not.toHaveTextContent(/screen capture failed/i);
  });
});
