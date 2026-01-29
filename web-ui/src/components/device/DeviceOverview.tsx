import { useState } from 'react';
import { useTelemetry } from '../../hooks/useTelemetry';
import { usePolicies } from '../../hooks/usePolicies';
import { Badge } from '../ui/Badge';
import { Spinner } from '../ui/Spinner';
import { Button } from '../ui/Button';
import { API_BASE, apiFetch } from '../../utils/api';
import type { Device } from '../../hooks/useDevices';
import './DeviceComponents.css';

interface DeviceOverviewProps {
  device: Device & { location?: { latitude: number; longitude: number; accuracy: number | null; source?: 'manual' | 'telemetry' } | null };
  onDeviceUpdate?: () => void;
}

export function DeviceOverview({ device, onDeviceUpdate }: DeviceOverviewProps) {
  const { telemetry, loading } = useTelemetry(device.id);
  const { policies, assignToDevice } = usePolicies();
  const [assigningPolicy, setAssigningPolicy] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(device.name);
  const [savingName, setSavingName] = useState(false);
  const [editingLocation, setEditingLocation] = useState(false);
  const [latValue, setLatValue] = useState(device.location?.latitude?.toString() ?? '');
  const [lngValue, setLngValue] = useState(device.location?.longitude?.toString() ?? '');
  const [savingLocation, setSavingLocation] = useState(false);

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

  const handleSaveName = async () => {
    if (!nameValue.trim() || nameValue === device.name) {
      setEditingName(false);
      setNameValue(device.name);
      return;
    }
    setSavingName(true);
    try {
      await apiFetch(`${API_BASE}/api/devices/${device.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nameValue.trim() }),
      });
      setEditingName(false);
      onDeviceUpdate?.();
    } catch (error) {
      console.error('Failed to update device name:', error);
    } finally {
      setSavingName(false);
    }
  };

  const handleSaveLocation = async () => {
    setSavingLocation(true);
    try {
      const lat = latValue.trim() ? parseFloat(latValue) : null;
      const lng = lngValue.trim() ? parseFloat(lngValue) : null;

      if (lat !== null && lng !== null) {
        if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
          alert('Invalid coordinates. Latitude: -90 to 90, Longitude: -180 to 180.');
          setSavingLocation(false);
          return;
        }
      }

      await apiFetch(`${API_BASE}/api/devices/${device.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ latitude: lat, longitude: lng }),
      });
      setEditingLocation(false);
      onDeviceUpdate?.();
    } catch (error) {
      console.error('Failed to update device location:', error);
    } finally {
      setSavingLocation(false);
    }
  };

  const handleClearLocation = async () => {
    setSavingLocation(true);
    try {
      await apiFetch(`${API_BASE}/api/devices/${device.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ latitude: null, longitude: null }),
      });
      setLatValue('');
      setLngValue('');
      setEditingLocation(false);
      onDeviceUpdate?.();
    } catch (error) {
      console.error('Failed to clear device location:', error);
    } finally {
      setSavingLocation(false);
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
            {editingName ? (
              <span className="device-overview__value" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <input
                  type="text"
                  value={nameValue}
                  onChange={(e) => setNameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveName();
                    if (e.key === 'Escape') { setEditingName(false); setNameValue(device.name); }
                  }}
                  autoFocus
                  style={{
                    background: 'rgba(255,255,255,0.1)',
                    border: '1px solid #0f3460',
                    borderRadius: '4px',
                    padding: '2px 8px',
                    color: 'inherit',
                    fontSize: 'inherit',
                    width: '200px',
                  }}
                  disabled={savingName}
                />
                <Button size="sm" variant="primary" onClick={handleSaveName} loading={savingName}>Save</Button>
                <Button size="sm" variant="ghost" onClick={() => { setEditingName(false); setNameValue(device.name); }}>Cancel</Button>
              </span>
            ) : (
              <span className="device-overview__value" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                {device.name}
                <Button size="sm" variant="ghost" onClick={() => { setEditingName(true); setNameValue(device.name); }}>Edit</Button>
              </span>
            )}
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
          <div className="device-overview__item">
            <span className="device-overview__label">Location</span>
            {editingLocation ? (
              <span className="device-overview__value" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  value={latValue}
                  onChange={(e) => setLatValue(e.target.value)}
                  placeholder="Latitude"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveLocation();
                    if (e.key === 'Escape') { setEditingLocation(false); setLatValue(device.location?.latitude?.toString() ?? ''); setLngValue(device.location?.longitude?.toString() ?? ''); }
                  }}
                  autoFocus
                  style={{
                    background: 'rgba(255,255,255,0.1)',
                    border: '1px solid #0f3460',
                    borderRadius: '4px',
                    padding: '2px 8px',
                    color: 'inherit',
                    fontSize: 'inherit',
                    width: '120px',
                  }}
                  disabled={savingLocation}
                />
                <input
                  type="text"
                  value={lngValue}
                  onChange={(e) => setLngValue(e.target.value)}
                  placeholder="Longitude"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveLocation();
                    if (e.key === 'Escape') { setEditingLocation(false); setLatValue(device.location?.latitude?.toString() ?? ''); setLngValue(device.location?.longitude?.toString() ?? ''); }
                  }}
                  style={{
                    background: 'rgba(255,255,255,0.1)',
                    border: '1px solid #0f3460',
                    borderRadius: '4px',
                    padding: '2px 8px',
                    color: 'inherit',
                    fontSize: 'inherit',
                    width: '120px',
                  }}
                  disabled={savingLocation}
                />
                <Button size="sm" variant="primary" onClick={handleSaveLocation} loading={savingLocation}>Save</Button>
                <Button size="sm" variant="ghost" onClick={() => { setEditingLocation(false); setLatValue(device.location?.latitude?.toString() ?? ''); setLngValue(device.location?.longitude?.toString() ?? ''); }}>Cancel</Button>
              </span>
            ) : (
              <span className="device-overview__value" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                {device.location ? (
                  <>
                    <a
                      href={`https://maps.google.com/?q=${device.location.latitude},${device.location.longitude}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: '#e94560', textDecoration: 'none' }}
                    >
                      {device.location.latitude.toFixed(6)}, {device.location.longitude.toFixed(6)}
                    </a>
                    {device.location.source === 'telemetry' && (
                      <span style={{ fontSize: '0.75rem', color: '#888' }}>(GPS)</span>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => { setEditingLocation(true); setLatValue(device.location!.latitude.toString()); setLngValue(device.location!.longitude.toString()); }}>Edit</Button>
                    {device.location.source === 'manual' && (
                      <Button size="sm" variant="ghost" onClick={handleClearLocation} loading={savingLocation}>Clear</Button>
                    )}
                  </>
                ) : (
                  <>
                    No location data
                    <Button size="sm" variant="ghost" onClick={() => { setEditingLocation(true); setLatValue(''); setLngValue(''); }}>Set</Button>
                  </>
                )}
              </span>
            )}
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
