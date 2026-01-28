import { useState, useEffect } from 'react';
import { makeStyles, mergeClasses } from '@fluentui/react-components';

const API_BASE = import.meta.env.DEV ? 'http://localhost:7899' : '';

interface EnrollmentToken {
  id: string;
  token: string;
  createdAt: number;
  expiresAt: number | null;
  maxUses: number | null;
  usedCount: number;
  isActive: boolean;
}

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
  const [tokens, setTokens] = useState<EnrollmentToken[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchTokens();
  }, []);

  const fetchTokens = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/enroll/tokens`);
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
      const res = await fetch(`${API_BASE}/api/enroll/tokens`, {
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
      await fetch(`${API_BASE}/api/enroll/tokens/${tokenId}`, {
        method: 'DELETE',
      });
      fetchTokens();
    } catch (err) {
      console.error('Failed to revoke token:', err);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <div className={styles.root}>
      <h1 className={styles.title}>Settings</h1>

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

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Server Information</h2>
        <div className={styles.info}>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>Version</span>
            <span className={styles.infoValue}>0.1.0</span>
          </div>
          <div className={mergeClasses(styles.infoRow, styles.infoRowLast)}>
            <span className={styles.infoLabel}>Server URL</span>
            <span className={styles.infoValue}>{API_BASE || window.location.origin}</span>
          </div>
        </div>
      </section>
    </div>
  );
}
