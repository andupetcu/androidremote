import { Link } from 'react-router-dom';
import type { Device } from '../hooks/useDevices';
import './DeviceCard.css';

interface DeviceCardProps {
  device: Device;
  onUnenroll?: (id: string) => void;
}

export function DeviceCard({ device, onUnenroll }: DeviceCardProps) {
  const handleUnenroll = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (onUnenroll && confirm(`Unenroll ${device.name}?`)) {
      onUnenroll(device.id);
    }
  };

  const formatDate = (timestamp: number | null) => {
    if (!timestamp) return 'Never';
    return new Date(timestamp).toLocaleString();
  };

  return (
    <Link to={`/devices/${device.id}`} className="device-card">
      <div className="device-card__header">
        <span className={`device-card__status device-card__status--${device.status}`} />
        <span className="device-card__name">{device.name}</span>
      </div>

      <div className="device-card__info">
        {device.model && (
          <div className="device-card__row">
            <span className="device-card__label">Model</span>
            <span className="device-card__value">{device.model}</span>
          </div>
        )}
        {device.androidVersion && (
          <div className="device-card__row">
            <span className="device-card__label">Android</span>
            <span className="device-card__value">{device.androidVersion}</span>
          </div>
        )}
        <div className="device-card__row">
          <span className="device-card__label">Last seen</span>
          <span className="device-card__value">{formatDate(device.lastSeenAt)}</span>
        </div>
      </div>

      <div className="device-card__actions">
        <span className="device-card__connect">Connect</span>
        <button
          className="device-card__unenroll"
          onClick={handleUnenroll}
          title="Unenroll device"
        >
          Remove
        </button>
      </div>
    </Link>
  );
}
