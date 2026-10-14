import { useState } from 'react';
import { useDeviceApps } from '../../hooks/useApps';
import { useDeviceCommands, CommandHelpers } from '../../hooks/useCommands';
import { usePolicies } from '../../hooks/usePolicies';
import { useTelemetry } from '../../hooks/useTelemetry';
import { latestCommand, applyState } from '../../lib/deviceState';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import type { Device } from '../../types/api';
import './DeviceComponents.css';

interface DeviceKioskProps {
  device: Pick<Device, 'id' | 'policyId' | 'complianceStatus'>;
}

/** Kiosk panel: choose the app, lock task on/off, and see what was actually applied. */
export function DeviceKiosk({ device }: DeviceKioskProps) {
  const { apps } = useDeviceApps(device.id);
  const { commands, sendCommand } = useDeviceCommands(device.id);
  const { policies } = usePolicies();
  const { telemetry } = useTelemetry(device.id);
  const [pkg, setPkg] = useState('');
  const [lockTask, setLockTask] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const policy = policies.find((p) => p.id === device.policyId) ?? null;
  const kioskCmd = latestCommand(commands, 'SET_KIOSK');
  const kioskState = applyState(kioskCmd);
  const kp = (kioskCmd?.payload ?? {}) as { packageName?: string; enabled?: boolean; lockTask?: boolean };
  const syncCmd = latestCommand(commands, 'SYNC_POLICY');
  const syncState = applyState(syncCmd);

  const lastApplied = latestCommand(commands, 'SET_KIOSK', { skipDead: true });
  const active = lastApplied?.status === 'completed' && (lastApplied.payload as { enabled?: boolean }).enabled === true;

  const run = async (enabled: boolean) => {
    const target = enabled ? pkg : ((lastApplied?.payload as { packageName?: string } | undefined)?.packageName ?? pkg);
    if (!target) {
      setError('Choose the kiosk app first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await CommandHelpers.setKiosk(sendCommand, target, enabled, lockTask);
    } catch (err) {
      setError(`Could not send the kiosk command: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  };

  const describeKiosk = () => {
    if (!kioskCmd) return 'No kiosk command sent yet.';
    const what = `${kp.enabled ? 'Enable' : 'Disable'} kiosk for ${kp.packageName ?? '?'} (lock task ${kp.lockTask ? 'on' : 'off'})`;
    if (kioskState === 'applied') return `Applied: ${what}.`;
    if (kioskState === 'failed') return `Failed: ${what}. ${kioskCmd.status === 'expired' ? 'The device did not pick it up in time.' : (kioskCmd.error ?? '')}`;
    return `Applying (${kioskCmd.status}): ${what}.`;
  };

  return (
    <div className="device-kiosk">
      <div className="device-overview__section">
        <h3>Kiosk</h3>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <label>
            Kiosk app{' '}
            <select value={pkg} onChange={(e) => setPkg(e.target.value)}>
              <option value="">Select an app</option>
              {apps.filter((a) => !a.isSystemApp || a.packageName === pkg).map((a) => (
                <option key={a.packageName} value={a.packageName}>
                  {a.appName || a.packageName} ({a.packageName})
                </option>
              ))}
            </select>
          </label>
          <label>
            <input type="checkbox" checked={lockTask} onChange={(e) => setLockTask(e.target.checked)} /> Lock task (user cannot leave the app)
          </label>
          <Button size="sm" loading={busy} onClick={() => run(true)}>Enable kiosk</Button>
          <Button size="sm" variant="secondary" loading={busy} onClick={() => run(false)}>Disable kiosk</Button>
        </div>
        {error && <div role="alert" className="device-commands__result device-commands__result--error">{error}</div>}
        <div data-testid="kiosk-reported" style={{ marginTop: 12 }}>
          {telemetry && telemetry.kioskActive !== null ? (
            <>
              Device reports: kiosk {telemetry.kioskActive ? 'active' : 'not active'}
              {telemetry.kioskPackage ? ` for ${telemetry.kioskPackage}` : ''}
              {telemetry.kioskPackage ? ` (lock task ${telemetry.lockTask ? 'on' : 'off'})` : ''}.
            </>
          ) : (
            'The device has not reported its kiosk state yet.'
          )}
        </div>
        <div data-testid="kiosk-status" style={{ marginTop: 12 }}>
          <Badge variant={kioskState === 'applied' ? 'success' : kioskState === 'failed' ? 'error' : 'info'} size="sm">
            {active ? 'kiosk on' : 'kiosk off'}
          </Badge>{' '}
          {describeKiosk()}
        </div>
      </div>

      <div className="device-overview__section" data-testid="policy-status">
        <h3>Policy</h3>
        <p>
          Assigned policy: {policy ? policy.name : device.policyId ? device.policyId : 'none'}. Compliance:{' '}
          {device.complianceStatus === 'non_compliant' ? 'non-compliant' : device.complianceStatus}.
        </p>
        <p>
          Last policy sync:{' '}
          {syncState === 'none' ? 'none sent' : syncState === 'applied' ? 'applied' : syncState === 'failed' ? `failed ${syncCmd?.error ?? ''}` : `in progress (${syncCmd?.status})`}.
        </p>
        <p>
          Boot app from policy: {policy?.kioskMode && policy.kioskPackage ? policy.kioskPackage : 'none'}
        </p>
      </div>
    </div>
  );
}
