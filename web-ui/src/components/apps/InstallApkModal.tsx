import { useState, useEffect } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Spinner } from '../ui/Spinner';
import type { AppPackage } from '../../hooks/useApps';
import type { Device } from '../../types/api';
import { API_BASE, apiFetch } from '../../utils/api';
import './InstallApkModal.css';

interface InstallApkModalProps {
  open: boolean;
  onClose: () => void;
  pkg: AppPackage | null;
  onInstall: (packageName: string, deviceIds: string[]) => Promise<unknown>;
}

export function InstallApkModal({ open, onClose, pkg, onInstall }: InstallApkModalProps) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedDevices, setSelectedDevices] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'online' | 'offline'>('all');

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

  const handleInstall = async () => {
    if (!pkg || selectedDevices.size === 0) return;

    setInstalling(true);
    setError(null);

    try {
      await onInstall(pkg.packageName, Array.from(selectedDevices));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Installation failed');
    } finally {
      setInstalling(false);
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
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Selection Summary */}
        <div className="install-apk-modal__summary">
          {selectedDevices.size} device{selectedDevices.size !== 1 ? 's' : ''} selected
        </div>

        {/* Error */}
        {error && (
          <div className="install-apk-modal__error">{error}</div>
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
