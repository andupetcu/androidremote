import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { makeStyles, mergeClasses } from '@fluentui/react-components';
import { usePolicies } from '../hooks/usePolicies';
import { useAppPackages } from '../hooks/useApps';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { Spinner } from '../components/ui/Spinner';
import { EmptyState } from '../components/ui/EmptyState';
import type { PolicyInput, RequiredAppConfig } from '../types/api';

const useStyles = makeStyles({
  root: {
    padding: '1.5rem',
    maxWidth: '1000px',
    margin: '0 auto',
    '@media (max-width: 768px)': {
      padding: '1rem',
    },
  },
  loading: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '400px',
    gap: '1rem',
    color: '#888',
  },
  header: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    gap: '1rem',
    marginBottom: '2rem',
    paddingBottom: '1.5rem',
    borderBottom: '1px solid #0f3460',
    '@media (max-width: 768px)': {
      flexDirection: 'column',
    },
  },
  nav: {
    width: '100%',
    marginBottom: '0.5rem',
  },
  info: {
    flex: 1,
  },
  title: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
  },
  titleH1: {
    margin: 0,
    fontSize: '1.75rem',
    color: '#fff',
  },
  description: {
    margin: '0.5rem 0 0',
    color: '#888',
  },
  meta: {
    display: 'flex',
    gap: '1.5rem',
    marginTop: '0.75rem',
    fontSize: '0.875rem',
    color: '#888',
    '@media (max-width: 768px)': {
      flexDirection: 'column',
      gap: '0.25rem',
    },
  },
  actions: {
    display: 'flex',
    gap: '0.5rem',
    '@media (max-width: 768px)': {
      width: '100%',
      justifyContent: 'flex-end',
    },
  },
  main: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.5rem',
  },
  section: {
    backgroundColor: '#16213e',
    border: '1px solid #0f3460',
    borderRadius: '0.5rem',
    padding: '1.25rem',
  },
  sectionTitle: {
    margin: '0 0 1rem',
    fontSize: '1.125rem',
    color: '#fff',
    borderBottom: '1px solid #0f3460',
    paddingBottom: '0.75rem',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: '1rem',
    '@media (max-width: 768px)': {
      gridTemplateColumns: '1fr',
    },
  },
  gridSwitches: {
    gridTemplateColumns: 'repeat(3, 1fr)',
    '@media (max-width: 768px)': {
      gridTemplateColumns: '1fr',
    },
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
  },
  fieldLabel: {
    fontSize: '0.8125rem',
    color: '#888',
    fontWeight: '500',
  },
  fieldFull: {
    gridColumn: '1 / -1',
  },
  fieldCheckbox: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  checkboxLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    cursor: 'pointer',
    fontSize: '0.875rem',
    color: '#eee',
  },
  checkbox: {
    width: '1rem',
    height: '1rem',
    accentColor: '#e94560',
  },
  checkboxDisabled: {
    cursor: 'not-allowed',
    opacity: 0.7,
  },
  value: {
    color: '#eee',
    fontSize: '0.875rem',
  },
  input: {
    backgroundColor: '#1a1a2e',
    border: '1px solid #0f3460',
    borderRadius: '0.375rem',
    padding: '0.625rem',
    color: '#eee',
    fontSize: '0.875rem',
    fontFamily: 'inherit',
    ':focus': {
      outline: 'none',
      border: '1px solid #e94560',
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
  },
  select: {
    backgroundColor: '#1a1a2e',
    border: '1px solid #0f3460',
    borderRadius: '0.375rem',
    padding: '0.625rem',
    color: '#eee',
    fontSize: '0.875rem',
    fontFamily: 'inherit',
    ':focus': {
      outline: 'none',
      border: '1px solid #e94560',
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
  },
  textarea: {
    backgroundColor: '#1a1a2e',
    border: '1px solid #0f3460',
    borderRadius: '0.375rem',
    padding: '0.625rem',
    color: '#eee',
    fontSize: '0.875rem',
    fontFamily: 'inherit',
    resize: 'vertical',
    minHeight: '60px',
    ':focus': {
      outline: 'none',
      border: '1px solid #e94560',
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
  },
  hint: {
    color: '#888',
    fontSize: '0.875rem',
    margin: 0,
  },
  link: {
    color: '#e94560',
    textDecoration: 'none',
    ':hover': {
      textDecoration: 'underline',
    },
  },
  loadingInline: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    color: '#888',
    fontSize: '0.875rem',
  },
  noPackages: {
    color: '#888',
    fontSize: '0.875rem',
  },
  requiredApps: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    border: '1px solid #0f3460',
    borderRadius: '0.5rem',
    maxHeight: '300px',
    overflowY: 'auto',
  },
  appItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    padding: '0.75rem 1rem',
    cursor: 'pointer',
    borderBottom: '1px solid #0f3460',
    transitionProperty: 'background',
    transitionDuration: '0.15s',
    ':last-child': {
      borderBottom: 'none',
    },
    ':hover': {
      backgroundColor: 'rgba(233, 69, 96, 0.05)',
    },
  },
  appItemSelected: {
    backgroundColor: 'rgba(233, 69, 96, 0.1)',
  },
  appItemCheckbox: {
    width: '18px',
    height: '18px',
    accentColor: '#e94560',
  },
  appInfo: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    minWidth: 0,
  },
  appName: {
    fontWeight: '500',
    color: '#fff',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  appPackage: {
    fontFamily: 'monospace',
    fontSize: '0.75rem',
    color: '#666',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  appVersion: {
    fontSize: '0.875rem',
    color: '#888',
    whiteSpace: 'nowrap',
  },
  selectedCount: {
    marginTop: '0.75rem',
    fontSize: '0.875rem',
    color: '#888',
  },
  appOptions: {
    display: 'flex',
    gap: '1rem',
    marginTop: '0.5rem',
    paddingTop: '0.5rem',
    borderTop: '1px solid #0f3460',
  },
  appOption: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.375rem',
    fontSize: '0.75rem',
    color: '#888',
  },
  appOptionCheckbox: {
    width: '14px',
    height: '14px',
    accentColor: '#e94560',
  },
  appOptionRadio: {
    width: '14px',
    height: '14px',
    accentColor: '#e94560',
  },
  appItemExpanded: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  appItemHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
  },
});

export function PolicyDetailPage() {
  const styles = useStyles();
  const { policyId } = useParams<{ policyId: string }>();
  const navigate = useNavigate();
  const { policies, loading, error, updatePolicy, refresh } = usePolicies();
  const { packages, loading: packagesLoading } = useAppPackages();
  const policy = policies.find((p) => p.id === policyId);

  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [formData, setFormData] = useState<PolicyInput>({
    name: '',
    description: '',
  });

  useEffect(() => {
    if (policy) {
      setFormData({
        name: policy.name,
        description: policy.description || '',
        isDefault: policy.isDefault,
        kioskMode: policy.kioskMode,
        kioskPackage: policy.kioskPackage || '',
        kioskExitPassword: policy.kioskExitPassword || '',
        allowedApps: policy.allowedApps || [],
        blockedApps: policy.blockedApps || [],
        playStoreEnabled: policy.playStoreEnabled,
        unknownSourcesEnabled: policy.unknownSourcesEnabled,
        passwordRequired: policy.passwordRequired,
        passwordMinLength: policy.passwordMinLength || 0,
        passwordComplexity: policy.passwordComplexity || 'none',
        encryptionRequired: policy.encryptionRequired,
        maxFailedAttempts: policy.maxFailedAttempts || 0,
        cameraEnabled: policy.cameraEnabled,
        microphoneEnabled: policy.microphoneEnabled,
        bluetoothEnabled: policy.bluetoothEnabled,
        wifiEnabled: policy.wifiEnabled,
        usbEnabled: policy.usbEnabled,
        sdCardEnabled: policy.sdCardEnabled,
        vpnRequired: policy.vpnRequired,
        allowedWifiSsids: policy.allowedWifiSsids || [],
        adbEnabled: policy.adbEnabled,
        developerOptionsEnabled: policy.developerOptionsEnabled,
        factoryResetEnabled: policy.factoryResetEnabled,
        otaUpdatesEnabled: policy.otaUpdatesEnabled,
        requiredApps: policy.requiredApps || [],
        silentMode: policy.silentMode,
      });
    }
  }, [policy]);

  const handleSave = async () => {
    if (!policyId || isSaving) return;
    setIsSaving(true);
    try {
      await updatePolicy(policyId, formData);
      setIsEditing(false);
      await refresh();
    } catch (err) {
      console.error('Failed to update policy:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    if (policy) {
      setFormData({
        name: policy.name,
        description: policy.description || '',
        isDefault: policy.isDefault,
        kioskMode: policy.kioskMode,
        kioskPackage: policy.kioskPackage || '',
        kioskExitPassword: policy.kioskExitPassword || '',
        allowedApps: policy.allowedApps || [],
        blockedApps: policy.blockedApps || [],
        playStoreEnabled: policy.playStoreEnabled,
        unknownSourcesEnabled: policy.unknownSourcesEnabled,
        passwordRequired: policy.passwordRequired,
        passwordMinLength: policy.passwordMinLength || 0,
        passwordComplexity: policy.passwordComplexity || 'none',
        encryptionRequired: policy.encryptionRequired,
        maxFailedAttempts: policy.maxFailedAttempts || 0,
        cameraEnabled: policy.cameraEnabled,
        microphoneEnabled: policy.microphoneEnabled,
        bluetoothEnabled: policy.bluetoothEnabled,
        wifiEnabled: policy.wifiEnabled,
        usbEnabled: policy.usbEnabled,
        sdCardEnabled: policy.sdCardEnabled,
        vpnRequired: policy.vpnRequired,
        allowedWifiSsids: policy.allowedWifiSsids || [],
        adbEnabled: policy.adbEnabled,
        developerOptionsEnabled: policy.developerOptionsEnabled,
        factoryResetEnabled: policy.factoryResetEnabled,
        otaUpdatesEnabled: policy.otaUpdatesEnabled,
        requiredApps: policy.requiredApps || [],
        silentMode: policy.silentMode,
      });
    }
    setIsEditing(false);
  };

  const updateField = <K extends keyof PolicyInput>(key: K, value: PolicyInput[K]) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
  };

  const parseArrayField = (value: string): string[] => {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  };

  if (loading) {
    return (
      <div className={styles.root}>
        <div className={styles.loading}>
          <Spinner size="lg" />
          <p>Loading policy...</p>
        </div>
      </div>
    );
  }

  if (error || !policy) {
    return (
      <div className={styles.root}>
        <EmptyState
          title="Policy not found"
          description={error || 'The requested policy does not exist.'}
          action={
            <Button onClick={() => navigate('/policies')}>Back to Policies</Button>
          }
        />
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.nav}>
          <Button variant="ghost" onClick={() => navigate('/policies')}>
            &larr; Back to Policies
          </Button>
        </div>

        <div className={styles.info}>
          <div className={styles.title}>
            <h1 className={styles.titleH1}>{policy.name}</h1>
            {policy.isDefault && <Badge variant="info" size="sm">Default</Badge>}
          </div>
          {policy.description && (
            <p className={styles.description}>{policy.description}</p>
          )}
          <div className={styles.meta}>
            <span>Created: {new Date(policy.createdAt).toLocaleDateString()}</span>
            <span>Updated: {new Date(policy.updatedAt).toLocaleDateString()}</span>
          </div>
        </div>

        <div className={styles.actions}>
          {isEditing ? (
            <>
              <Button variant="secondary" onClick={handleCancel}>
                Cancel
              </Button>
              <Button onClick={handleSave} loading={isSaving}>
                Save Changes
              </Button>
            </>
          ) : (
            <Button onClick={() => setIsEditing(true)}>Edit Policy</Button>
          )}
        </div>
      </header>

      <main className={styles.main}>
        {/* Basic Information */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Basic Information</h2>
          <div className={styles.grid}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Policy Name</label>
              {isEditing ? (
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => updateField('name', e.target.value)}
                  className={styles.input}
                />
              ) : (
                <span className={styles.value}>{policy.name}</span>
              )}
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Description</label>
              {isEditing ? (
                <textarea
                  value={formData.description || ''}
                  onChange={(e) => updateField('description', e.target.value)}
                  className={styles.textarea}
                  rows={2}
                />
              ) : (
                <span className={styles.value}>{policy.description || '-'}</span>
              )}
            </div>
            <div className={mergeClasses(styles.field, styles.fieldCheckbox)}>
              <label className={styles.checkboxLabel}>
                {isEditing ? (
                  <input
                    type="checkbox"
                    checked={formData.isDefault || false}
                    onChange={(e) => updateField('isDefault', e.target.checked)}
                    className={styles.checkbox}
                  />
                ) : (
                  <input type="checkbox" checked={policy.isDefault ?? false} disabled className={mergeClasses(styles.checkbox, styles.checkboxDisabled)} />
                )}
                <span>Set as Default Policy</span>
              </label>
            </div>
          </div>
        </section>

        {/* Kiosk Mode */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Kiosk Mode</h2>
          <div className={styles.grid}>
            <div className={mergeClasses(styles.field, styles.fieldCheckbox)}>
              <label className={styles.checkboxLabel}>
                {isEditing ? (
                  <input
                    type="checkbox"
                    checked={formData.kioskMode || false}
                    onChange={(e) => updateField('kioskMode', e.target.checked)}
                    className={styles.checkbox}
                  />
                ) : (
                  <input type="checkbox" checked={policy.kioskMode ?? false} disabled className={mergeClasses(styles.checkbox, styles.checkboxDisabled)} />
                )}
                <span>Enable Kiosk Mode</span>
              </label>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Kiosk Package Name</label>
              {isEditing ? (
                <input
                  type="text"
                  value={formData.kioskPackage || ''}
                  onChange={(e) => updateField('kioskPackage', e.target.value)}
                  className={styles.input}
                  placeholder="com.example.app"
                  disabled={!formData.kioskMode}
                />
              ) : (
                <span className={styles.value}>{policy.kioskPackage || '-'}</span>
              )}
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Exit Password</label>
              {isEditing ? (
                <input
                  type="password"
                  value={formData.kioskExitPassword || ''}
                  onChange={(e) => updateField('kioskExitPassword', e.target.value)}
                  className={styles.input}
                  placeholder="••••••••"
                  disabled={!formData.kioskMode}
                />
              ) : (
                <span className={styles.value}>
                  {policy.kioskExitPassword ? '••••••••' : '-'}
                </span>
              )}
            </div>
          </div>
        </section>

        {/* App Management */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>App Management</h2>
          <div className={styles.grid}>
            <div className={mergeClasses(styles.field, styles.fieldCheckbox)}>
              <label className={styles.checkboxLabel}>
                {isEditing ? (
                  <input
                    type="checkbox"
                    checked={formData.playStoreEnabled || false}
                    onChange={(e) => updateField('playStoreEnabled', e.target.checked)}
                    className={styles.checkbox}
                  />
                ) : (
                  <input type="checkbox" checked={policy.playStoreEnabled ?? false} disabled className={mergeClasses(styles.checkbox, styles.checkboxDisabled)} />
                )}
                <span>Play Store Enabled</span>
              </label>
            </div>
            <div className={mergeClasses(styles.field, styles.fieldCheckbox)}>
              <label className={styles.checkboxLabel}>
                {isEditing ? (
                  <input
                    type="checkbox"
                    checked={formData.unknownSourcesEnabled || false}
                    onChange={(e) => updateField('unknownSourcesEnabled', e.target.checked)}
                    className={styles.checkbox}
                  />
                ) : (
                  <input type="checkbox" checked={policy.unknownSourcesEnabled ?? false} disabled className={mergeClasses(styles.checkbox, styles.checkboxDisabled)} />
                )}
                <span>Allow Unknown Sources</span>
              </label>
            </div>
            <div className={mergeClasses(styles.field, styles.fieldFull)}>
              <label className={styles.fieldLabel}>Allowed Apps (comma-separated package names)</label>
              {isEditing ? (
                <textarea
                  value={(formData.allowedApps || []).join(', ')}
                  onChange={(e) => updateField('allowedApps', parseArrayField(e.target.value))}
                  className={styles.textarea}
                  placeholder="com.app1, com.app2"
                  rows={2}
                />
              ) : (
                <span className={styles.value}>
                  {policy.allowedApps?.join(', ') || 'All apps allowed'}
                </span>
              )}
            </div>
            <div className={mergeClasses(styles.field, styles.fieldFull)}>
              <label className={styles.fieldLabel}>Blocked Apps (comma-separated package names)</label>
              {isEditing ? (
                <textarea
                  value={(formData.blockedApps || []).join(', ')}
                  onChange={(e) => updateField('blockedApps', parseArrayField(e.target.value))}
                  className={styles.textarea}
                  placeholder="com.blocked1, com.blocked2"
                  rows={2}
                />
              ) : (
                <span className={styles.value}>
                  {policy.blockedApps?.join(', ') || 'No apps blocked'}
                </span>
              )}
            </div>
          </div>
        </section>

        {/* Security */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Security</h2>
          <div className={styles.grid}>
            <div className={mergeClasses(styles.field, styles.fieldCheckbox)}>
              <label className={styles.checkboxLabel}>
                {isEditing ? (
                  <input
                    type="checkbox"
                    checked={formData.passwordRequired || false}
                    onChange={(e) => updateField('passwordRequired', e.target.checked)}
                    className={styles.checkbox}
                  />
                ) : (
                  <input type="checkbox" checked={policy.passwordRequired ?? false} disabled className={mergeClasses(styles.checkbox, styles.checkboxDisabled)} />
                )}
                <span>Password Required</span>
              </label>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Minimum Password Length</label>
              {isEditing ? (
                <input
                  type="number"
                  min="0"
                  max="16"
                  value={formData.passwordMinLength || 0}
                  onChange={(e) => updateField('passwordMinLength', parseInt(e.target.value) || 0)}
                  className={styles.input}
                  disabled={!formData.passwordRequired}
                />
              ) : (
                <span className={styles.value}>{policy.passwordMinLength || '-'}</span>
              )}
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Password Complexity</label>
              {isEditing ? (
                <select
                  value={formData.passwordComplexity || 'none'}
                  onChange={(e) => updateField('passwordComplexity', e.target.value)}
                  className={styles.select}
                  disabled={!formData.passwordRequired}
                >
                  <option value="none">None</option>
                  <option value="numeric">Numeric</option>
                  <option value="alphanumeric">Alphanumeric</option>
                  <option value="complex">Complex</option>
                </select>
              ) : (
                <span className={styles.value}>{policy.passwordComplexity || '-'}</span>
              )}
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Max Failed Attempts</label>
              {isEditing ? (
                <input
                  type="number"
                  min="0"
                  max="30"
                  value={formData.maxFailedAttempts || 0}
                  onChange={(e) => updateField('maxFailedAttempts', parseInt(e.target.value) || 0)}
                  className={styles.input}
                />
              ) : (
                <span className={styles.value}>{policy.maxFailedAttempts || 'Unlimited'}</span>
              )}
            </div>
            <div className={mergeClasses(styles.field, styles.fieldCheckbox)}>
              <label className={styles.checkboxLabel}>
                {isEditing ? (
                  <input
                    type="checkbox"
                    checked={formData.encryptionRequired || false}
                    onChange={(e) => updateField('encryptionRequired', e.target.checked)}
                    className={styles.checkbox}
                  />
                ) : (
                  <input type="checkbox" checked={policy.encryptionRequired ?? false} disabled className={mergeClasses(styles.checkbox, styles.checkboxDisabled)} />
                )}
                <span>Encryption Required</span>
              </label>
            </div>
          </div>
        </section>

        {/* Hardware */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Hardware Controls</h2>
          <div className={mergeClasses(styles.grid, styles.gridSwitches)}>
            {[
              { key: 'cameraEnabled', label: 'Camera' },
              { key: 'microphoneEnabled', label: 'Microphone' },
              { key: 'bluetoothEnabled', label: 'Bluetooth' },
              { key: 'wifiEnabled', label: 'WiFi' },
              { key: 'usbEnabled', label: 'USB' },
              { key: 'sdCardEnabled', label: 'SD Card' },
            ].map(({ key, label }) => (
              <div key={key} className={mergeClasses(styles.field, styles.fieldCheckbox)}>
                <label className={styles.checkboxLabel}>
                  {isEditing ? (
                    <input
                      type="checkbox"
                      checked={(formData as unknown as Record<string, boolean>)[key] || false}
                      onChange={(e) =>
                        updateField(key as keyof PolicyInput, e.target.checked)
                      }
                      className={styles.checkbox}
                    />
                  ) : (
                    <input
                      type="checkbox"
                      checked={(policy as unknown as Record<string, boolean>)[key] ?? false}
                      disabled
                      className={mergeClasses(styles.checkbox, styles.checkboxDisabled)}
                    />
                  )}
                  <span>{label}</span>
                </label>
              </div>
            ))}
          </div>
        </section>

        {/* Network */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Network</h2>
          <div className={styles.grid}>
            <div className={mergeClasses(styles.field, styles.fieldCheckbox)}>
              <label className={styles.checkboxLabel}>
                {isEditing ? (
                  <input
                    type="checkbox"
                    checked={formData.vpnRequired || false}
                    onChange={(e) => updateField('vpnRequired', e.target.checked)}
                    className={styles.checkbox}
                  />
                ) : (
                  <input type="checkbox" checked={policy.vpnRequired ?? false} disabled className={mergeClasses(styles.checkbox, styles.checkboxDisabled)} />
                )}
                <span>VPN Required</span>
              </label>
            </div>
            <div className={mergeClasses(styles.field, styles.fieldFull)}>
              <label className={styles.fieldLabel}>Allowed WiFi SSIDs (comma-separated)</label>
              {isEditing ? (
                <textarea
                  value={(formData.allowedWifiSsids || []).join(', ')}
                  onChange={(e) => updateField('allowedWifiSsids', parseArrayField(e.target.value))}
                  className={styles.textarea}
                  placeholder="NetworkA, NetworkB"
                  rows={2}
                />
              ) : (
                <span className={styles.value}>
                  {policy.allowedWifiSsids?.join(', ') || 'Any network allowed'}
                </span>
              )}
            </div>
          </div>
        </section>

        {/* Developer Options */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Developer Options</h2>
          <div className={mergeClasses(styles.grid, styles.gridSwitches)}>
            <div className={mergeClasses(styles.field, styles.fieldCheckbox)}>
              <label className={styles.checkboxLabel}>
                {isEditing ? (
                  <input
                    type="checkbox"
                    checked={formData.developerOptionsEnabled || false}
                    onChange={(e) => updateField('developerOptionsEnabled', e.target.checked)}
                    className={styles.checkbox}
                  />
                ) : (
                  <input type="checkbox" checked={policy.developerOptionsEnabled ?? false} disabled className={mergeClasses(styles.checkbox, styles.checkboxDisabled)} />
                )}
                <span>Developer Options</span>
              </label>
            </div>
            <div className={mergeClasses(styles.field, styles.fieldCheckbox)}>
              <label className={styles.checkboxLabel}>
                {isEditing ? (
                  <input
                    type="checkbox"
                    checked={formData.adbEnabled || false}
                    onChange={(e) => updateField('adbEnabled', e.target.checked)}
                    className={styles.checkbox}
                  />
                ) : (
                  <input type="checkbox" checked={policy.adbEnabled ?? false} disabled className={mergeClasses(styles.checkbox, styles.checkboxDisabled)} />
                )}
                <span>ADB Debugging</span>
              </label>
            </div>
          </div>
        </section>

        {/* System */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>System</h2>
          <div className={mergeClasses(styles.grid, styles.gridSwitches)}>
            <div className={mergeClasses(styles.field, styles.fieldCheckbox)}>
              <label className={styles.checkboxLabel}>
                {isEditing ? (
                  <input
                    type="checkbox"
                    checked={formData.factoryResetEnabled || false}
                    onChange={(e) => updateField('factoryResetEnabled', e.target.checked)}
                    className={styles.checkbox}
                  />
                ) : (
                  <input type="checkbox" checked={policy.factoryResetEnabled ?? false} disabled className={mergeClasses(styles.checkbox, styles.checkboxDisabled)} />
                )}
                <span>Factory Reset Allowed</span>
              </label>
            </div>
            <div className={mergeClasses(styles.field, styles.fieldCheckbox)}>
              <label className={styles.checkboxLabel}>
                {isEditing ? (
                  <input
                    type="checkbox"
                    checked={formData.otaUpdatesEnabled || false}
                    onChange={(e) => updateField('otaUpdatesEnabled', e.target.checked)}
                    className={styles.checkbox}
                  />
                ) : (
                  <input type="checkbox" checked={policy.otaUpdatesEnabled ?? false} disabled className={mergeClasses(styles.checkbox, styles.checkboxDisabled)} />
                )}
                <span>OTA Updates Enabled</span>
              </label>
            </div>
            <div className={mergeClasses(styles.field, styles.fieldCheckbox)}>
              <label className={styles.checkboxLabel}>
                {isEditing ? (
                  <input
                    type="checkbox"
                    checked={formData.silentMode || false}
                    onChange={(e) => updateField('silentMode', e.target.checked)}
                    className={styles.checkbox}
                  />
                ) : (
                  <input type="checkbox" checked={policy.silentMode ?? false} disabled className={mergeClasses(styles.checkbox, styles.checkboxDisabled)} />
                )}
                <span>Silent Mode (DND)</span>
              </label>
            </div>
          </div>
        </section>

        {/* Required Apps */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Required Apps</h2>
          <p className={styles.hint} style={{ marginBottom: '1rem' }}>
            Apps selected here will be automatically installed on devices with this policy.
            Apps must be uploaded first on the{' '}
            <Link to="/apps" className={styles.link}>Apps page</Link>.
          </p>
          {packagesLoading ? (
            <div className={styles.loadingInline}>
              <Spinner size="sm" /> Loading available packages...
            </div>
          ) : packages.length === 0 ? (
            <p className={styles.noPackages}>
              No uploaded packages available.{' '}
              <Link to="/apps" className={styles.link}>Upload APKs</Link> first.
            </p>
          ) : (
            <div className={styles.requiredApps}>
              {packages.map((pkg) => {
                const appConfig = (formData.requiredApps || []).find(
                  (app) => app.packageName === pkg.packageName
                );
                const isSelected = !!appConfig;

                const updateAppConfig = (updates: Partial<RequiredAppConfig>) => {
                  const current = formData.requiredApps || [];
                  const index = current.findIndex((a) => a.packageName === pkg.packageName);
                  if (index >= 0) {
                    const updated = [...current];
                    // If setting foregroundApp to true, clear it from all other apps
                    if (updates.foregroundApp) {
                      updated.forEach((a, i) => {
                        if (i !== index) a.foregroundApp = false;
                      });
                    }
                    updated[index] = { ...updated[index], ...updates };
                    updateField('requiredApps', updated);
                  }
                };

                return (
                  <div
                    key={pkg.id}
                    className={mergeClasses(
                      styles.appItem,
                      isSelected && styles.appItemSelected,
                      isSelected && isEditing && styles.appItemExpanded
                    )}
                  >
                    <div className={styles.appItemHeader}>
                      {isEditing ? (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={(e) => {
                            const current = formData.requiredApps || [];
                            if (e.target.checked) {
                              updateField('requiredApps', [
                                ...current,
                                { packageName: pkg.packageName },
                              ]);
                            } else {
                              updateField(
                                'requiredApps',
                                current.filter((a) => a.packageName !== pkg.packageName)
                              );
                            }
                          }}
                          className={styles.appItemCheckbox}
                        />
                      ) : (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled
                          className={styles.appItemCheckbox}
                        />
                      )}
                      <div className={styles.appInfo}>
                        <span className={styles.appName}>
                          {pkg.appName || pkg.packageName}
                        </span>
                        <span className={styles.appPackage}>{pkg.packageName}</span>
                      </div>
                      {pkg.versionName && (
                        <span className={styles.appVersion}>v{pkg.versionName}</span>
                      )}
                    </div>
                    {isSelected && isEditing && (
                      <div className={styles.appOptions}>
                        <label className={styles.appOption}>
                          <input
                            type="checkbox"
                            checked={appConfig?.autoStartAfterInstall || false}
                            onChange={(e) =>
                              updateAppConfig({ autoStartAfterInstall: e.target.checked })
                            }
                            className={styles.appOptionCheckbox}
                          />
                          <span>Auto-start after install</span>
                        </label>
                        <label className={styles.appOption}>
                          <input
                            type="radio"
                            name="foregroundApp"
                            checked={appConfig?.foregroundApp || false}
                            onChange={(e) =>
                              updateAppConfig({ foregroundApp: e.target.checked })
                            }
                            className={styles.appOptionRadio}
                          />
                          <span>Foreground app</span>
                        </label>
                        <label className={styles.appOption}>
                          <input
                            type="checkbox"
                            checked={appConfig?.autoStartOnBoot || false}
                            onChange={(e) =>
                              updateAppConfig({ autoStartOnBoot: e.target.checked })
                            }
                            className={styles.appOptionCheckbox}
                          />
                          <span>Auto-start on boot</span>
                        </label>
                      </div>
                    )}
                    {isSelected && !isEditing && (
                      <div className={styles.appOptions}>
                        {appConfig?.autoStartAfterInstall && (
                          <span className={styles.appOption}>Auto-start</span>
                        )}
                        {appConfig?.foregroundApp && (
                          <Badge variant="info" size="sm">Foreground</Badge>
                        )}
                        {appConfig?.autoStartOnBoot && (
                          <span className={styles.appOption}>Boot start</span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {(formData.requiredApps?.length || 0) > 0 && (
            <p className={styles.selectedCount}>
              {formData.requiredApps?.length} app
              {formData.requiredApps?.length !== 1 ? 's' : ''} selected
            </p>
          )}
        </section>

        {/* Assigned Devices Link */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Assigned Devices</h2>
          <p className={styles.hint}>
            View devices using this policy on the{' '}
            <Link to="/devices" className={styles.link}>
              Devices page
            </Link>
            .
          </p>
        </section>
      </main>
    </div>
  );
}
