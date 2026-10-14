import { useState } from 'react';
import { useDeviceCommands, CommandHelpers } from '../../hooks/useCommands';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Spinner } from '../ui/Spinner';
import { EmptyState } from '../ui/EmptyState';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import type { CommandStatus } from '../../types/api';
import './DeviceComponents.css';

interface DeviceCommandsProps {
  deviceId: string;
}

export function DeviceCommands({ deviceId }: DeviceCommandsProps) {
  const { commands, loading, error, refresh, sendCommand } = useDeviceCommands(deviceId);
  const [sending, setSending] = useState<string | null>(null);
  const [volumeLevel, setVolumeLevel] = useState(50);

  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<'lock' | 'reboot' | 'wipe' | null>(null);

  const CONFIRMS = {
    lock: { title: 'Lock device?', label: 'Lock device', body: 'The device screen will be locked immediately.', run: () => CommandHelpers.lock(sendCommand) },
    reboot: { title: 'Reboot device?', label: 'Reboot', body: 'The device will restart and be unavailable for a minute or two. Anyone using it will be interrupted.', run: () => CommandHelpers.reboot(sendCommand) },
    wipe: { title: 'Wipe device?', label: 'Wipe device', body: 'This factory-resets the device and ERASES ALL DATA. It cannot be undone.', run: () => CommandHelpers.wipe(sendCommand, deviceId) },
  } as const;

  const handleCommand = async (action: () => Promise<unknown>, name: string) => {
    setSending(name);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(`Could not send ${name} command: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setSending(null);
    }
  };

  const statusVariant = (status: CommandStatus): 'info' | 'success' | 'warning' | 'error' => {
    switch (status) {
      case 'pending': return 'warning';
      case 'delivered': return 'info';
      case 'executing': return 'info';
      case 'completed': return 'success';
      case 'failed': return 'error';
      case 'expired': return 'warning';
      default: return 'info';
    }
  };

  if (loading) {
    return (
      <div className="device-tab__loading">
        <Spinner size="md" />
        <p>Loading commands...</p>
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        title="Error loading commands"
        description={error}
        action={<Button onClick={refresh}>Retry</Button>}
      />
    );
  }

  return (
    <div className="device-commands">
      {actionError && (
        <div role="alert" className="device-commands__result device-commands__result--error">
          {actionError}
        </div>
      )}
      {pendingConfirm && (
        <ConfirmDialog
          open
          title={CONFIRMS[pendingConfirm].title}
          confirmLabel={CONFIRMS[pendingConfirm].label}
          requireText={pendingConfirm === 'wipe' ? deviceId : undefined}
          onCancel={() => setPendingConfirm(null)}
          onConfirm={() => {
            const c = CONFIRMS[pendingConfirm];
            const name = pendingConfirm;
            setPendingConfirm(null);
            void handleCommand(c.run, name);
          }}
        >
          <p>{CONFIRMS[pendingConfirm].body}</p>
        </ConfirmDialog>
      )}
      <div className="device-commands__actions">
        <h3>Quick Actions</h3>
        <div className="device-commands__buttons">
          <Button
            variant="secondary"
            size="sm"
            loading={sending === 'lock'}
            onClick={() => setPendingConfirm('lock')}
          >
            Lock Device
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={sending === 'reboot'}
            onClick={() => setPendingConfirm('reboot')}
          >
            Reboot
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={sending === 'screenshot'}
            onClick={() => handleCommand(() => CommandHelpers.takeScreenshot(sendCommand), 'screenshot')}
          >
            Screenshot
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={sending === 'location'}
            onClick={() => handleCommand(() => CommandHelpers.getLocation(sendCommand), 'location')}
          >
            Get Location
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={sending === 'telemetry'}
            onClick={() => handleCommand(() => CommandHelpers.refreshTelemetry(sendCommand), 'telemetry')}
          >
            Refresh Telemetry
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={sending === 'sound'}
            onClick={() => handleCommand(() => CommandHelpers.playSound(sendCommand), 'sound')}
          >
            Play Sound
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={sending === 'syncPolicy'}
            onClick={() => handleCommand(() => CommandHelpers.syncPolicy(sendCommand), 'syncPolicy')}
          >
            Reapply Policy
          </Button>
          <Button
            variant="danger"
            size="sm"
            loading={sending === 'wipe'}
            onClick={() => setPendingConfirm('wipe')}
          >
            Wipe Device
          </Button>
        </div>
      </div>

      <div className="device-commands__volume">
        <h3>Volume Control</h3>
        <div className="device-commands__volume-row">
          <input
            type="range"
            min={0}
            max={100}
            value={volumeLevel}
            onChange={(e) => setVolumeLevel(Number(e.target.value))}
            className="device-commands__volume-slider"
          />
          <span className="device-commands__volume-value">{volumeLevel}%</span>
          <Button
            variant="secondary"
            size="sm"
            loading={sending === 'setVolume'}
            onClick={() => handleCommand(() => CommandHelpers.setVolume(sendCommand, volumeLevel), 'setVolume')}
          >
            Set Volume
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={sending === 'mute'}
            onClick={() => {
              setVolumeLevel(0);
              return handleCommand(() => CommandHelpers.setVolume(sendCommand, 0), 'mute');
            }}
          >
            Mute
          </Button>
        </div>
      </div>

      <div className="device-commands__history">
        <div className="device-commands__history-header">
          <h3>Command History</h3>
          <Button variant="ghost" size="sm" onClick={refresh}>
            Refresh
          </Button>
        </div>
        {commands.length === 0 ? (
          <p className="device-commands__empty">No commands sent yet</p>
        ) : (
          <div className="device-commands__list">
            {commands.map((cmd) => (
              <div key={cmd.id} className="device-commands__item">
                <div className="device-commands__item-info">
                  <span className="device-commands__type">{cmd.type}</span>
                  <Badge variant={statusVariant(cmd.status)} size="sm">
                    {cmd.status}
                  </Badge>
                </div>
                <div className="device-commands__item-meta">
                  <span>Created: {new Date(cmd.createdAt).toLocaleString()}</span>
                  {cmd.completedAt && (
                    <span>Completed: {new Date(cmd.completedAt).toLocaleString()}</span>
                  )}
                </div>
                {cmd.error && (
                  <pre className="device-commands__result device-commands__result--error">
                    Error: {cmd.error}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
