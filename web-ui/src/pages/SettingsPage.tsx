import { useState, useEffect } from 'react';
import { makeStyles, mergeClasses } from '@fluentui/react-components';
import { API_BASE, apiFetch } from '../utils/api';

interface EnrollmentToken {
  id: string;
  token: string;
  createdAt: number;
  expiresAt: number | null;
  maxUses: number | null;
  usedCount: number;
  isActive: boolean;
}

const ADB_INSTRUCTIONS = `# ── Standard ADB Install ──────────────────────────

# 1. Install main APK
adb install -r android-remote.apk

# 2. Set as device owner
adb shell dpm set-device-owner com.androidremote.app/.admin.DeviceOwnerReceiver

# 3. Auto-enroll via ADB (replace TOKEN and SERVER_URL)
adb shell am start -n com.androidremote.app/.MainActivity \\
  -e enrollment_token "YOUR_TOKEN" \\
  -e server_url "https://your-server.com"

# Note: User must manually enable AccessibilityService
# (Android security prevents auto-enable)

# ── Factory Reset Enrollment ─────────────────────

# 1. Factory reset the device
# 2. During Android setup, skip Google account
# 3. Connect to WiFi
# 4. Enable USB debugging (Settings > Developer Options)
# 5. Install APK via ADB:
adb install -r android-remote.apk

# 6. Set device owner (must be done before any account is added):
adb shell dpm set-device-owner com.androidremote.app/.admin.DeviceOwnerReceiver

# 7. Auto-enroll with token:
adb shell am start -n com.androidremote.app/.MainActivity \\
  -e enrollment_token "YOUR_TOKEN" \\
  -e server_url "https://your-server.com"

# Device Owner auto-grants permissions (camera, storage, notifications).
# The root daemon is a separate binary and persists across app updates.
# App self-updates via INSTALL_APK command preserve Device Owner status.`;

const useStyles = makeStyles({
  root: {
    maxWidth: '800px',
  },
  title: {
    margin: '0 0 2rem',
    fontSize: '1.5rem',
  },
  section: {
    backgroundColor: '#16213e',
    border: '1px solid #0f3460',
    borderRadius: '0.5rem',
    padding: '1.5rem',
    marginBottom: '1.5rem',
  },
  sectionHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '1rem',
  },
  sectionTitle: {
    margin: 0,
    fontSize: '1.125rem',
    fontWeight: '600',
  },
  formGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
    marginBottom: '1rem',
    '& label': {
      fontSize: '0.875rem',
      color: '#888',
    },
  },
  input: {
    backgroundColor: '#1a1a2e',
    border: '1px solid #0f3460',
    borderRadius: '0.375rem',
    padding: '0.5rem 0.75rem',
    fontSize: '0.875rem',
    color: '#e0e0e0',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  },
  saveBtn: {
    backgroundColor: '#e94560',
    color: 'white',
    border: 'none',
    padding: '0.5rem 1rem',
    borderRadius: '0.375rem',
    fontSize: '0.875rem',
    cursor: 'pointer',
    transitionProperty: 'background',
    transitionDuration: '0.2s',
    ':hover': {
      backgroundColor: '#ff6b6b',
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
  },
  successMsg: {
    color: '#22c55e',
    fontSize: '0.8125rem',
    marginTop: '0.5rem',
  },
  errorMsg: {
    color: '#ef4444',
    fontSize: '0.8125rem',
    marginTop: '0.5rem',
  },
  codeBlock: {
    backgroundColor: '#1a1a2e',
    border: '1px solid #0f3460',
    borderRadius: '0.375rem',
    padding: '1rem',
    fontFamily: 'monospace',
    fontSize: '0.8125rem',
    lineHeight: '1.6',
    color: '#e0e0e0',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    overflowX: 'auto',
    margin: 0,
  },
  createBtn: {
    backgroundColor: '#e94560',
    color: 'white',
    border: 'none',
    padding: '0.5rem 1rem',
    borderRadius: '0.375rem',
    fontSize: '0.875rem',
    cursor: 'pointer',
    transitionProperty: 'background',
    transitionDuration: '0.2s',
    ':hover': {
      backgroundColor: '#ff6b6b',
    },
  },
  tokens: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  token: {
    backgroundColor: '#1a1a2e',
    border: '1px solid #0f3460',
    borderRadius: '0.375rem',
    padding: '1rem',
  },
  tokenInactive: {
    opacity: 0.5,
  },
  tokenHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    marginBottom: '0.5rem',
  },
  tokenValue: {
    backgroundColor: '#0f3460',
    padding: '0.375rem 0.75rem',
    borderRadius: '0.25rem',
    fontSize: '0.875rem',
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  copyBtn: {
    backgroundColor: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: '0.25rem',
    fontSize: '1rem',
    opacity: 0.7,
    transitionProperty: 'opacity',
    transitionDuration: '0.2s',
    ':hover': {
      opacity: 1,
    },
  },
  tokenMeta: {
    display: 'flex',
    gap: '1rem',
    fontSize: '0.75rem',
    color: '#888',
    marginBottom: '0.5rem',
  },
  tokenActions: {
    display: 'flex',
    alignItems: 'center',
  },
  revokeBtn: {
    backgroundColor: 'transparent',
    border: '1px solid #ef4444',
    color: '#ef4444',
    padding: '0.25rem 0.75rem',
    borderRadius: '0.25rem',
    fontSize: '0.75rem',
    cursor: 'pointer',
    transitionProperty: 'all',
    transitionDuration: '0.2s',
    ':hover': {
      backgroundColor: 'rgba(239, 68, 68, 0.1)',
    },
  },
  tokenStatus: {
    fontSize: '0.75rem',
    color: '#888',
  },
  info: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  infoRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '0.5rem 0',
    borderBottom: '1px solid #0f3460',
  },
  infoRowLast: {
    borderBottom: 'none',
  },
  infoLabel: {
    color: '#888',
    fontSize: '0.875rem',
  },
  infoValue: {
    fontSize: '0.875rem',
    fontFamily: 'monospace',
  },
  empty: {
    textAlign: 'center',
    padding: '2rem',
    color: '#888',
  },
  loading: {
    textAlign: 'center',
    padding: '2rem',
    color: '#888',
  },
});

export function SettingsPage() {
  const styles = useStyles();

  // Settings state
  const [serverName, setServerName] = useState('');
  const [serverNameMsg, setServerNameMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordMsg, setPasswordMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [appsUpdateTime, setAppsUpdateTime] = useState<number>(3);
  const [appsUpdateTimeMsg, setAppsUpdateTimeMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [copiedAdb, setCopiedAdb] = useState(false);

  // Token state
  const [tokens, setTokens] = useState<EnrollmentToken[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchSettings();
    fetchTokens();
  }, []);

  const fetchSettings = async () => {
    try {
      const res = await apiFetch(`${API_BASE}/api/settings`);
      if (res.ok) {
        const data = await res.json();
        if (data.serverName !== undefined) setServerName(data.serverName);
        if (data.appsUpdateTime !== undefined) setAppsUpdateTime(data.appsUpdateTime);
      }
    } catch (err) {
      console.error('Failed to fetch settings:', err);
    }
  };

  const handleSaveServerName = async () => {
    try {
      const res = await apiFetch(`${API_BASE}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverName }),
      });
      if (res.ok) {
        setServerNameMsg({ type: 'success', text: 'Server name saved.' });
      } else {
        setServerNameMsg({ type: 'error', text: 'Failed to save server name.' });
      }
    } catch {
      setServerNameMsg({ type: 'error', text: 'Failed to save server name.' });
    }
  };

  const handleChangePassword = async () => {
    if (newPassword !== confirmPassword) {
      setPasswordMsg({ type: 'error', text: 'New passwords do not match.' });
      return;
    }
    if (!currentPassword || !newPassword) {
      setPasswordMsg({ type: 'error', text: 'All fields are required.' });
      return;
    }
    try {
      const res = await apiFetch(`${API_BASE}/api/auth/password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (res.ok) {
        setPasswordMsg({ type: 'success', text: 'Password changed successfully.' });
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } else {
        const data = await res.json().catch(() => null);
        setPasswordMsg({ type: 'error', text: data?.error || 'Failed to change password.' });
      }
    } catch {
      setPasswordMsg({ type: 'error', text: 'Failed to change password.' });
    }
  };

  const handleSaveAppsUpdateTime = async () => {
    try {
      const res = await apiFetch(`${API_BASE}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appsUpdateTime }),
      });
      if (res.ok) {
        setAppsUpdateTimeMsg({ type: 'success', text: 'Apps update time saved.' });
      } else {
        setAppsUpdateTimeMsg({ type: 'error', text: 'Failed to save apps update time.' });
      }
    } catch {
      setAppsUpdateTimeMsg({ type: 'error', text: 'Failed to save apps update time.' });
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const handleCopyAdb = () => {
    navigator.clipboard.writeText(ADB_INSTRUCTIONS);
    setCopiedAdb(true);
    setTimeout(() => setCopiedAdb(false), 2000);
  };

  const fetchTokens = async () => {
    try {
      const res = await apiFetch(`${API_BASE}/api/enroll/tokens`);
      const data = await res.json();
      setTokens(data.tokens || []);
    } catch (err) {
      console.error('Failed to fetch tokens:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateToken = async () => {
    try {
      const res = await apiFetch(`${API_BASE}/api/enroll/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        fetchTokens();
      }
    } catch (err) {
      console.error('Failed to create token:', err);
    }
  };

  const handleRevokeToken = async (tokenId: string) => {
    try {
      await apiFetch(`${API_BASE}/api/enroll/tokens/${tokenId}`, {
        method: 'DELETE',
      });
      fetchTokens();
    } catch (err) {
      console.error('Failed to revoke token:', err);
    }
  };

  return (
    <div className={styles.root}>
      <h1 className={styles.title}>Settings</h1>

      {/* Server Name */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Server Name</h2>
        <div className={styles.formGroup} style={{ marginTop: '1rem' }}>
          <label>Name</label>
          <input
            className={styles.input}
            type="text"
            value={serverName}
            onChange={(e) => { setServerName(e.target.value); setServerNameMsg(null); }}
            placeholder="My Android Remote Server"
          />
        </div>
        <button className={styles.saveBtn} onClick={handleSaveServerName}>Save</button>
        {serverNameMsg && (
          <div className={serverNameMsg.type === 'success' ? styles.successMsg : styles.errorMsg}>
            {serverNameMsg.text}
          </div>
        )}
      </section>

      {/* Change Password */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Change Password</h2>
        <div className={styles.formGroup} style={{ marginTop: '1rem' }}>
          <label>Current Password</label>
          <input
            className={styles.input}
            type="password"
            value={currentPassword}
            onChange={(e) => { setCurrentPassword(e.target.value); setPasswordMsg(null); }}
          />
        </div>
        <div className={styles.formGroup}>
          <label>New Password</label>
          <input
            className={styles.input}
            type="password"
            value={newPassword}
            onChange={(e) => { setNewPassword(e.target.value); setPasswordMsg(null); }}
          />
        </div>
        <div className={styles.formGroup}>
          <label>Confirm New Password</label>
          <input
            className={styles.input}
            type="password"
            value={confirmPassword}
            onChange={(e) => { setConfirmPassword(e.target.value); setPasswordMsg(null); }}
          />
        </div>
        <button className={styles.saveBtn} onClick={handleChangePassword}>Save</button>
        {passwordMsg && (
          <div className={passwordMsg.type === 'success' ? styles.successMsg : styles.errorMsg}>
            {passwordMsg.text}
          </div>
        )}
      </section>

      {/* Apps Update Time */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Apps Update Time</h2>
        <div className={styles.formGroup} style={{ marginTop: '1rem' }}>
          <label>Hour of day (0-23)</label>
          <input
            className={styles.input}
            type="number"
            min={0}
            max={23}
            value={appsUpdateTime}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              if (!isNaN(val) && val >= 0 && val <= 23) setAppsUpdateTime(val);
              setAppsUpdateTimeMsg(null);
            }}
          />
        </div>
        <button className={styles.saveBtn} onClick={handleSaveAppsUpdateTime}>Save</button>
        {appsUpdateTimeMsg && (
          <div className={appsUpdateTimeMsg.type === 'success' ? styles.successMsg : styles.errorMsg}>
            {appsUpdateTimeMsg.text}
          </div>
        )}
      </section>

      {/* ADB Installation Instructions */}
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>ADB Installation Instructions</h2>
          <button className={styles.createBtn} onClick={handleCopyAdb}>
            {copiedAdb ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <pre className={styles.codeBlock}>{ADB_INSTRUCTIONS}</pre>
      </section>

      {/* Enrollment Tokens */}
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Enrollment Tokens</h2>
          <button className={styles.createBtn} onClick={handleCreateToken}>
            + Create Token
          </button>
        </div>

        {loading ? (
          <div className={styles.loading}>Loading tokens...</div>
        ) : (
          <div className={styles.tokens}>
            {tokens.map((token) => (
              <div key={token.id} className={mergeClasses(styles.token, !token.isActive && styles.tokenInactive)}>
                <div className={styles.tokenHeader}>
                  <code className={styles.tokenValue}>{token.token}</code>
                  <button
                    className={styles.copyBtn}
                    onClick={() => copyToClipboard(token.token)}
                    title="Copy token"
                  >
                    📋
                  </button>
                </div>
                <div className={styles.tokenMeta}>
                  <span>Used: {token.usedCount}{token.maxUses ? `/${token.maxUses}` : ''}</span>
                  <span>Created: {new Date(token.createdAt).toLocaleDateString()}</span>
                  {token.expiresAt && (
                    <span>Expires: {new Date(token.expiresAt).toLocaleDateString()}</span>
                  )}
                </div>
                <div className={styles.tokenActions}>
                  {token.isActive && (
                    <button
                      className={styles.revokeBtn}
                      onClick={() => handleRevokeToken(token.id)}
                    >
                      Revoke
                    </button>
                  )}
                  {!token.isActive && (
                    <span className={styles.tokenStatus}>Revoked</span>
                  )}
                </div>
              </div>
            ))}
            {tokens.length === 0 && (
              <div className={styles.empty}>
                No enrollment tokens. Create one to enroll devices.
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
