import { useState, useEffect, useRef } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Spinner } from '../ui/Spinner';
import type { AppPackage } from '../../hooks/useApps';
import type { Device, DeviceCommand } from '../../types/api';
import { API_BASE, apiFetch } from '../../utils/api';
import './InstallApkModal.css';

interface InstallApkModalProps {
  open: boolean;
  onClose: () => void;
  pkg: AppPackage | null;
  onInstall: (packageName: string, deviceIds: string[]) => Promise<unknown>;
  /** How often to check install progress before queuing the reboot. */
  pollIntervalMs?: number;
}

const TERMINAL_FAILURE = new Set(['failed', 'expired']);

export function InstallApkModal({ open, onClose, pkg, onInstall, pollIntervalMs = 3000 }: InstallApkModalProps) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedDevices, setSelectedDevices] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'online' | 'offline'>('all');
  const [rebootAfterInstall, setRebootAfterInstall] = useState(false);
  const [progress, setProgress] = useState<Record<string, string>>({});
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = !open;
    return () => {
      cancelledRef.current = true;
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      loadDevices();
      setSelectedDevices(new Set());
      setError(null);
    }
  }, [open]);

  const loadDevices = async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`${API_BASE}/api/devices`);
      if (!res.ok) throw new Error('Failed to load devices');
      const data = await res.json();
      setDevices(data.devices);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load devices');
    } finally {
      setLoading(false);
    }
  };

  const filteredDevices = devices.filter((device) => {
    if (statusFilter === 'online') return device.status === 'online';
    if (statusFilter === 'offline') return device.status === 'offline';
    return true;
  });

  const toggleDevice = (deviceId: string) => {
    const newSelected = new Set(selectedDevices);
    if (newSelected.has(deviceId)) {
      newSelected.delete(deviceId);
    } else {
      newSelected.add(deviceId);
    }
    setSelectedDevices(newSelected);
  };

  const selectAll = () => {
    setSelectedDevices(new Set(filteredDevices.map(d => d.id)));
  };

  const selectAllOnline = () => {
    setSelectedDevices(new Set(devices.filter(d => d.status === 'online').map(d => d.id)));
  };

  const clearSelection = () => {
    setSelectedDevices(new Set());
  };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Wait until this device's INSTALL_APK reaches a terminal state. */
  const waitForInstall = async (deviceId: string, commandId?: string): Promise<DeviceCommand> => {
    for (;;) {
      await sleep(pollIntervalMs);
      if (cancelledRef.current) throw new Error('cancelled');
      const res = await apiFetch(`${API_BASE}/api/devices/${deviceId}/commands`);
      if (!res.ok) continue;
      const data = (await res.json()) as { commands: DeviceCommand[] };
      const cmd = commandId
        ? data.commands.find((c) => c.id === commandId)
        : data.commands.filter((c) => c.type === 'INSTALL_APK').sort((x, y) => y.createdAt - x.createdAt)[0];
      if (!cmd) continue;
      setProgress((p) => ({ ...p, [deviceId]: cmd.status }));
      if (cmd.status === 'completed' || TERMINAL_FAILURE.has(cmd.status)) return cmd;
    }
  };

  const handleInstall = async () => {
    if (!pkg || selectedDevices.size === 0) return;

    setInstalling(true);
    setError(null);
    setProgress({});

    try {
      const deviceIds = Array.from(selectedDevices);
      const result = (await onInstall(pkg.packageName, deviceIds)) as { commands?: Array<{ id?: string; deviceId?: string }> } | undefined;

      if (!rebootAfterInstall) {
        onClose();
        return;
      }

      // Reboot a device only after ITS install reports completed.
      const problems: string[] = [];
      await Promise.all(deviceIds.map(async (deviceId) => {
        const name = devices.find((d) => d.id === deviceId)?.name ?? deviceId;
        const queued = result?.commands?.find((c) => c.deviceId === deviceId);
        const cmd = await waitForInstall(deviceId, queued?.id);
        if (cmd.status !== 'completed') {
          problems.push(`${name}: install ${cmd.status}${cmd.error ? ` - ${cmd.error}` : ''}; not rebooting`);
          return;
        }
        const res = await apiFetch(`${API_BASE}/api/commands`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId, type: 'REBOOT', payload: {} }),
        });
        if (!res.ok) problems.push(`${name}: installed, but the reboot command was rejected (${res.status})`);
      }));

      if (problems.length > 0) {
        setError(problems.join('\n'));
        return;
      }
      onClose();
    } catch (err) {
      if (cancelledRef.current) return;
      setError(err instanceof Error ? err.message : 'Installation failed');
    } finally {
      if (!cancelledRef.current) setInstalling(false);
    }
  };

  const formatFileSize = (bytes: number | null): string => {
    if (!bytes) return '-';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  if (!pkg) return null;

  return (
    <Modal open={open} onClose={onClose} title="Install on Devices" size="lg">
      <div className="install-apk-modal">
        {/* Package Info */}
        <div className="install-apk-modal__package">
          <div className="install-apk-modal__package-icon">APK</div>
          <div className="install-apk-modal__package-info">
            <span className="install-apk-modal__package-name">{pkg.appName || pkg.packageName}</span>
            <span className="install-apk-modal__package-details">
              {pkg.packageName}
              {pkg.versionName && ` • v${pkg.versionName}`}
              {pkg.fileSize && ` • ${formatFileSize(pkg.fileSize)}`}
            </span>
          </div>
        </div>

        {/* Device Selection Controls */}
        <div className="install-apk-modal__controls">
          <div className="install-apk-modal__filters">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as 'all' | 'online' | 'offline')}
              className="install-apk-modal__select"
            >
              <option value="all">All Devices ({devices.length})</option>
              <option value="online">Online ({devices.filter(d => d.status === 'online').length})</option>
              <option value="offline">Offline ({devices.filter(d => d.status === 'offline').length})</option>
            </select>
          </div>
          <div className="install-apk-modal__quick-actions">
            <button type="button" className="install-apk-modal__quick-btn" onClick={selectAll}>
              Select All
            </button>
            <button type="button" className="install-apk-modal__quick-btn" onClick={selectAllOnline}>
              Select Online
            </button>
            <button type="button" className="install-apk-modal__quick-btn" onClick={clearSelection}>
              Clear
            </button>
          </div>
        </div>

        {/* Device List */}
        <div className="install-apk-modal__devices">
          {loading ? (
            <div className="install-apk-modal__loading">
              <Spinner size="md" />
              <span>Loading devices...</span>
            </div>
          ) : filteredDevices.length === 0 ? (
            <div className="install-apk-modal__empty">
              No devices found
            </div>
          ) : (
            <div className="install-apk-modal__device-list">
              {filteredDevices.map((device) => (
                <label
                  key={device.id}
                  className={`install-apk-modal__device ${selectedDevices.has(device.id) ? 'install-apk-modal__device--selected' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={selectedDevices.has(device.id)}
                    onChange={() => toggleDevice(device.id)}
                    className="install-apk-modal__checkbox"
                  />
                  <div className="install-apk-modal__device-info">
                    <span className="install-apk-modal__device-name">{device.name}</span>
                    <span className="install-apk-modal__device-model">{device.model || 'Unknown model'}</span>
                  </div>
                  <Badge
                    variant={device.status === 'online' ? 'success' : 'warning'}
                    size="sm"
                  >
                    {device.status}
                  </Badge>
                  {progress[device.id] && (
                    <span className="install-apk-modal__device-model">install {progress[device.id]}</span>
                  )}
                  {device.status !== 'online' && (
                    <span className="install-apk-modal__device-model">Offline: the install is queued and will run when the device reconnects</span>
                  )}
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Selection Summary */}
        <div className="install-apk-modal__summary">
          {selectedDevices.size} device{selectedDevices.size !== 1 ? 's' : ''} selected
        </div>

        {/* Options */}
        <label className="install-apk-modal__option">
          <input
            type="checkbox"
            checked={rebootAfterInstall}
            onChange={(e) => setRebootAfterInstall(e.target.checked)}
            className="install-apk-modal__checkbox"
          />
          <span>Reboot device after install (only once the install completes)</span>
        </label>

        {/* Error */}
        {error && (
          <div className="install-apk-modal__error" role="alert" style={{ whiteSpace: 'pre-line' }}>{error}</div>
        )}

        {/* Actions */}
        <div className="install-apk-modal__actions">
          <Button type="button" variant="secondary" onClick={onClose} disabled={installing}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={handleInstall}
            disabled={selectedDevices.size === 0 || installing}
          >
            {installing ? (
              <>
                <Spinner size="sm" />
                Installing...
              </>
            ) : (
              `Install on ${selectedDevices.size} Device${selectedDevices.size !== 1 ? 's' : ''}`
            )}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
