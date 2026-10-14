import { render, screen, waitFor, cleanup, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { API_BASE } from '../utils/api';
import { Pager } from '../components/ui/Pager';
import { DataTable } from '../components/data/DataTable';
import { EventsPage } from '../pages/EventsPage';
import { AuditPage } from '../pages/AuditPage';
import { DevicesPage } from '../pages/DevicesPage';
import { DeviceApps } from '../components/device/DeviceApps';
import { closeAdminSocket } from '../lib/adminSocket';

beforeEach(() => localStorage.setItem('auth_token', 'jwt'));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  closeAdminSocket();
});

describe('Pager (WU-17)', () => {
  it('shows the range and total and pages forwards and back', async () => {
    const onPage = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<Pager offset={0} limit={50} count={50} total={230} onPage={onPage} />);
    expect(screen.getByText(/showing 1.50 of 230/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(onPage).toHaveBeenCalledWith(50);
    rerender(<Pager offset={200} limit={50} count={30} total={230} onPage={onPage} />);
    expect(screen.getByText(/showing 201.230 of 230/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /previous/i }));
    expect(onPage).toHaveBeenLastCalledWith(150);
  });

  it('without a server total, Next is available while a full page came back', () => {
    const { rerender } = render(<Pager offset={0} limit={50} count={50} onPage={() => {}} />);
    expect(screen.getByText(/showing 1.50/i)).toBeInTheDocument();
    expect(screen.getByText(/more may exist/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next/i })).toBeEnabled();
    rerender(<Pager offset={50} limit={50} count={10} onPage={() => {}} />);
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
  });
});

const mkEvent = (i: number) => ({
  id: `e${i}`, deviceId: `device-${String(i).padStart(4, '0')}-xxxxxxxx`, eventType: 'battery-low', severity: 'warning',
  data: {}, acknowledged: false, acknowledgedAt: null, acknowledgedBy: null, createdAt: 1_000_000 - i,
});

describe('Events paging (WU-17)', () => {
  it('requests limit/offset, shows "Showing x-y of N" and loads the next page', async () => {
    const seen: Array<{ limit: string | null; offset: string | null }> = [];
    server.use(
      http.get(`${API_BASE}/api/events`, ({ request }) => {
        const u = new URL(request.url);
        const limit = Number(u.searchParams.get('limit'));
        const offset = Number(u.searchParams.get('offset') ?? 0);
        seen.push({ limit: u.searchParams.get('limit'), offset: u.searchParams.get('offset') });
        const events = Array.from({ length: Math.min(limit, 120 - offset) }, (_, i) => mkEvent(offset + i));
        return HttpResponse.json({ events, count: events.length, total: 120 });
      })
    );
    const user = userEvent.setup();
    render(<MemoryRouter><EventsPage /></MemoryRouter>);
    expect(await screen.findByText(/showing 1.50 of 120/i)).toBeInTheDocument();
    expect(seen[0].limit).toBe('50');
    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(await screen.findByText(/showing 51.100 of 120/i)).toBeInTheDocument();
    expect(seen.at(-1)).toEqual({ limit: '50', offset: '50' });
  });

  it('changing the filter goes back to the first page', async () => {
    const offsets: string[] = [];
    server.use(
      http.get(`${API_BASE}/api/events`, ({ request }) => {
        const u = new URL(request.url);
        const offset = Number(u.searchParams.get('offset') ?? 0);
        offsets.push(`${u.searchParams.get('severity') ?? 'any'}@${offset}`);
        const events = Array.from({ length: 50 }, (_, i) => mkEvent(offset + i));
        return HttpResponse.json({ events, count: 50, total: 200 });
      })
    );
    const user = userEvent.setup();
    render(<MemoryRouter><EventsPage /></MemoryRouter>);
    await screen.findByText(/showing 1.50 of 200/i);
    await user.click(screen.getByRole('button', { name: /next/i }));
    await screen.findByText(/showing 51.100 of 200/i);
    await user.click(screen.getByRole('button', { name: /^critical$/i }));
    await waitFor(() => expect(offsets.at(-1)).toBe('critical@0'));
  });
});

const mkLog = (i: number) => ({
  id: `a${i}`, timestamp: 2_000_000 - i, actorType: 'admin', actorId: 'root', action: 'command.queued',
  resourceType: 'device', resourceId: `res-${i}-xxxxxxxxxxx`, details: null, ipAddress: null,
});

describe('Audit paging (WU-17)', () => {
  it('pages through older records using limit/offset and the server total', async () => {
    const offsets: Array<string | null> = [];
    server.use(
      http.get(`${API_BASE}/api/audit`, ({ request }) => {
        const u = new URL(request.url);
        const offset = Number(u.searchParams.get('offset') ?? 0);
        offsets.push(u.searchParams.get('offset'));
        const logs = Array.from({ length: Math.min(Number(u.searchParams.get('limit')), 260 - offset) }, (_, i) => mkLog(offset + i));
        return HttpResponse.json({ logs, count: logs.length, total: 260 });
      })
    );
    const user = userEvent.setup();
    render(<MemoryRouter><AuditPage /></MemoryRouter>);
    expect(await screen.findByText(/showing 1.50 of 260/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(await screen.findByText(/showing 51.100 of 260/i)).toBeInTheDocument();
    expect(offsets.at(-1)).toBe('50');
  });
});

const mkDevice = (i: number) => ({
  id: `dev-${i}`, name: `Device ${i}`, model: 'Pixel', androidVersion: '14', enrolledAt: 1, lastSeenAt: 2,
  status: i % 2 ? 'online' : 'offline', osType: 'android', complianceStatus: 'compliant',
});

describe('Devices paging (WU-17)', () => {
  it('uses server limit/offset/search when the server supports them (total in the response)', async () => {
    const urls: URL[] = [];
    server.use(
      http.get(`${API_BASE}/api/devices`, ({ request }) => {
        const u = new URL(request.url);
        urls.push(u);
        const limit = Number(u.searchParams.get('limit') ?? 1000);
        const offset = Number(u.searchParams.get('offset') ?? 0);
        const all = Array.from({ length: 130 }, (_, i) => mkDevice(i));
        const q = u.searchParams.get('search');
        const pool = q ? all.filter((d) => d.name.includes(q)) : all;
        return HttpResponse.json({ devices: pool.slice(offset, offset + limit), total: pool.length });
      })
    );
    const user = userEvent.setup();
    render(<MemoryRouter><DevicesPage /></MemoryRouter>);
    expect(await screen.findByText(/showing 1.50 of 130/i)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /^Device \d+$/ })).toHaveLength(50);
    expect(urls[0].searchParams.get('limit')).toBe('50');
    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(await screen.findByText(/showing 51.100 of 130/i)).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: /search devices/i }), 'Device 12');
    await waitFor(() => expect(urls.at(-1)!.searchParams.get('search')).toBe('Device 12'), { timeout: 3000 });
    expect(urls.at(-1)!.searchParams.get('offset')).toBe('0');
  });

  it('falls back to client-side paging while the server still returns the whole list', async () => {
    server.use(
      http.get(`${API_BASE}/api/devices`, () => HttpResponse.json({ devices: Array.from({ length: 120 }, (_, i) => mkDevice(i)) }))
    );
    const user = userEvent.setup();
    render(<MemoryRouter><DevicesPage /></MemoryRouter>);
    expect(await screen.findByText(/showing 1.50 of 120/i)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /^Device \d+$/ })).toHaveLength(50);
    await user.click(screen.getByRole('button', { name: /next/i }));
    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(await screen.findByText(/showing 101.120 of 120/i)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /^Device \d+$/ })).toHaveLength(20);
  });
});

describe('Table virtualisation (WU-17)', () => {
  const rows = Array.from({ length: 5000 }, (_, i) => ({ id: `r${i}`, label: `Row ${i}` }));
  const columns = [{ key: 'label', header: 'Label' }];

  it('renders only a window of rows and moves the window on scroll', () => {
    render(<DataTable columns={columns} data={rows} keyExtractor={(r) => r.id} virtualRows={{ rowHeight: 40, height: 400 }} />);
    const bodyRows = () => screen.getAllByRole('row').slice(1).filter((r) => r.textContent?.startsWith('Row'));
    expect(bodyRows().length).toBeLessThan(40);
    expect(screen.getByText('Row 0')).toBeInTheDocument();
    expect(screen.queryByText('Row 3000')).toBeNull();
    const scroller = screen.getByTestId('virtual-scroller');
    scroller.scrollTop = 3000 * 40;
    fireEvent.scroll(scroller);
    expect(screen.getByText('Row 3000')).toBeInTheDocument();
    expect(screen.queryByText('Row 0')).toBeNull();
    expect(bodyRows().length).toBeLessThan(40);
  });

  it('plain tables (no virtualRows) are unchanged', () => {
    render(<DataTable columns={columns} data={rows.slice(0, 30)} keyExtractor={(r) => r.id} />);
    expect(screen.getByText('Row 29')).toBeInTheDocument();
  });

  it('DeviceApps virtualises a long app list', async () => {
    server.use(
      http.get(`${API_BASE}/api/devices/dev-1/apps`, () =>
        HttpResponse.json({
          apps: Array.from({ length: 2000 }, (_, i) => ({
            packageName: `com.example.app${i}`, appName: `App ${i}`, versionName: '1', versionCode: 1,
            installedAt: 1, updatedAt: 1, isSystemApp: false, enabled: true,
          })),
          count: 2000,
        })
      )
    );
    render(<MemoryRouter><DeviceApps deviceId="dev-1" /></MemoryRouter>);
    await screen.findByText('App 0');
    expect(screen.getByText(/2000 apps/)).toBeInTheDocument();
    expect(screen.getAllByRole('row').length).toBeLessThan(80);
    expect(within(screen.getByTestId('virtual-scroller')).queryByText('App 1500')).toBeNull();
  });
});
