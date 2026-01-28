import { useState } from 'react';
import { useTelemetry } from '../../hooks/useTelemetry';
import { usePolicies } from '../../hooks/usePolicies';
import { Badge } from '../ui/Badge';
import { Spinner } from '../ui/Spinner';
import type { Device } from '../../hooks/useDevices';
import './DeviceComponents.css';

interface DeviceOverviewProps {
  device: Device;
  onDeviceUpdate?: () => void;
}

export function DeviceOverview({ device, onDeviceUpdate }: DeviceOverviewProps) {
  const { telemetry, loading } = useTelemetry(device.id);
  const { policies, assignToDevice } = usePolicies();
  const [assigningPolicy, setAssigningPolicy] = useState(false);

  const formatDate = (timestamp: number | null) => {
    if (!timestamp) return 'Never';
    return new Date(timestamp).toLocaleString();
  };

  const handlePolicyChange = async (policyId: string) => {
    setAssigningPolicy(true);
    try {
      await assignToDevice(policyId || '', device.id);
      onDeviceUpdate?.();
    } catch (error) {
      console.error('Failed to assign policy:', error);
    } finally {
      setAssigningPolicy(false);
    }
  };

  const currentPolicy = policies.find(p => p.id === device.policyId);

  return (
    <div className="device-overview">
      <div className="device-overview__section">
        <h3>Device Information</h3>
        <div className="device-overview__grid">
          <div className="device-overview__item">
            <span className="device-overview__label">Name</span>
            <span className="device-overview__value">{device.name}</span>
          </div>
          <div className="device-overview__item">
            <span className="device-overview__label">Status</span>
            <Badge variant={device.status === 'online' ? 'success' : 'warning'} size="sm">
              {device.status}
            </Badge>
          </div>
          <div className="device-overview__item">
            <span className="device-overview__label">Model</span>
            <span className="device-overview__value">{device.model || 'Unknown'}</span>
          </div>
          <div className="device-overview__item">
            <span className="device-overview__label">Android Version</span>
            <span className="device-overview__value">{device.androidVersion || 'Unknown'}</span>
          </div>
          <div className="device-overview__item">
            <span className="device-overview__label">Enrolled</span>
            <span className="device-overview__value">{formatDate(device.enrolledAt)}</span>
          </div>
          <div className="device-overview__item">
            <span className="device-overview__label">Last Seen</span>
            <span className="device-overview__value">{formatDate(device.lastSeenAt)}</span>
          </div>
          <div className="device-overview__item device-overview__item--full">
            <span className="device-overview__label">Policy</span>
            <div className="device-overview__policy-select">
              <select
                value={device.policyId || ''}
                onChange={(e) => handlePolicyChange(e.target.value)}
                disabled={assigningPolicy}
                className="device-overview__select"
              >
                <option value="">No policy assigned</option>
                {policies.map((policy) => (
                  <option key={policy.id} value={policy.id}>
                    {policy.name}
                    {policy.isDefault ? ' (Default)' : ''}
                  </option>
                ))}
              </select>
              {assigningPolicy && <Spinner size="sm" />}
              {currentPolicy && (
                <span className="device-overview__policy-info">
                  {currentPolicy.kioskMode && <Badge variant="info" size="sm">Kiosk</Badge>}
                  {currentPolicy.silentMode && <Badge variant="neutral" size="sm">Silent</Badge>}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="device-overview__section">
        <h3>Telemetry</h3>
        {loading ? (
          <div className="device-overview__loading">
            <Spinner size="sm" />
            <span>Loading telemetry...</span>
          </div>
        ) : telemetry ? (
          <div className="device-overview__telemetry">
            {telemetry.batteryLevel !== null && (
              <div className="device-overview__gauge">
                <div className="device-overview__gauge-label">Battery</div>
                <div className="device-overview__gauge-bar">
                  <div
                    className={`device-overview__gauge-fill device-overview__gauge-fill--${
                      telemetry.batteryLevel > 20 ? 'good' : 'low'
                    }`}
                    style={{ width: `${telemetry.batteryLevel}%` }}
                  />
                </div>
                <div className="device-overview__gauge-value">
                  {telemetry.batteryLevel}%
                  {telemetry.batteryCharging && ' (Charging)'}
                </div>
              </div>
            )}

            {telemetry.storageTotal && telemetry.storageUsed !== null && (
              <div className="device-overview__gauge">
                <div className="device-overview__gauge-label">Storage</div>
                <div className="device-overview__gauge-bar">
                  <div
                    className="device-overview__gauge-fill"
                    style={{
                      width: `${(telemetry.storageUsed / telemetry.storageTotal) * 100}%`,
                    }}
                  />
                </div>
                <div className="device-overview__gauge-value">
                  {Math.round((telemetry.storageTotal - telemetry.storageUsed) / 1024 / 1024 / 1024)}GB free of{' '}
                  {Math.round(telemetry.storageTotal / 1024 / 1024 / 1024)}GB
                </div>
              </div>
            )}

            <div className="device-overview__grid">
              {telemetry.wifiSsid && (
                <div className="device-overview__item">
                  <span className="device-overview__label">WiFi</span>
                  <span className="device-overview__value">{telemetry.wifiSsid}</span>
                </div>
              )}
              {telemetry.ipAddress && (
                <div className="device-overview__item">
                  <span className="device-overview__label">IP Address</span>
                  <span className="device-overview__value">{telemetry.ipAddress}</span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <p className="device-overview__empty">No telemetry data available</p>
        )}
      </div>
    </div>
  );
}
