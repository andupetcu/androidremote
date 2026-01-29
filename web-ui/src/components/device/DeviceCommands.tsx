import { useState } from 'react';
import { useDeviceCommands, CommandHelpers } from '../../hooks/useCommands';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Spinner } from '../ui/Spinner';
import { EmptyState } from '../ui/EmptyState';
import type { CommandStatus } from '../../types/api';
import './DeviceComponents.css';

interface DeviceCommandsProps {
  deviceId: string;
}

export function DeviceCommands({ deviceId }: DeviceCommandsProps) {
  const { commands, loading, error, refresh, sendCommand } = useDeviceCommands(deviceId);
  const [sending, setSending] = useState<string | null>(null);

  const handleCommand = async (action: () => Promise<unknown>, name: string) => {
    setSending(name);
    try {
      await action();
    } catch (err) {
      console.error(`Failed to send ${name} command:`, err);
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
      <div className="device-commands__actions">
        <h3>Quick Actions</h3>
        <div className="device-commands__buttons">
          <Button
            variant="secondary"
            size="sm"
            loading={sending === 'lock'}
            onClick={() => handleCommand(() => CommandHelpers.lock(sendCommand), 'lock')}
          >
            Lock Device
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={sending === 'reboot'}
            onClick={() => handleCommand(() => CommandHelpers.reboot(sendCommand), 'reboot')}
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
