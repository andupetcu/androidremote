import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { makeStyles } from '@fluentui/react-components';
import { useAuth, getAuthHeaders } from '../hooks/useAuth';

const API_BASE = import.meta.env.DEV ? 'http://localhost:7899' : '';

const useStyles = makeStyles({
  root: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1a1a2e',
  },
  card: {
    backgroundColor: '#16213e',
    borderRadius: '12px',
    padding: '2.5rem',
    width: '100%',
    maxWidth: '400px',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)',
  },
  title: {
    color: '#eee',
    fontSize: '1.5rem',
    fontWeight: '600',
    textAlign: 'center',
    margin: '0 0 0.5rem',
  },
  subtitle: {
    color: '#f0ad4e',
    fontSize: '0.875rem',
    textAlign: 'center',
    margin: '0 0 2rem',
  },
  field: {
    marginBottom: '1rem',
  },
  label: {
    display: 'block',
    color: '#aaa',
    fontSize: '0.8125rem',
    marginBottom: '0.375rem',
  },
  input: {
    width: '100%',
    padding: '0.75rem',
    backgroundColor: '#0f3460',
    border: '1px solid #1a4a7a',
    borderRadius: '6px',
    color: '#eee',
    fontSize: '0.875rem',
    outline: 'none',
    boxSizing: 'border-box',
  },
  button: {
    width: '100%',
    padding: '0.75rem',
    backgroundColor: '#e94560',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '0.875rem',
    fontWeight: '600',
    cursor: 'pointer',
    marginTop: '0.5rem',
    ':hover': {
      backgroundColor: '#d63851',
    },
    ':disabled': {
      opacity: 0.6,
      cursor: 'not-allowed',
    },
  },
  error: {
    color: '#e94560',
    fontSize: '0.8125rem',
    textAlign: 'center',
    marginTop: '1rem',
  },
  success: {
    color: '#4caf50',
    fontSize: '0.8125rem',
    textAlign: 'center',
    marginTop: '1rem',
  },
});

export function ChangePasswordPage() {
  const styles = useStyles();
  const { clearMustChangePassword } = useAuth();
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to change password');
      }

      clearMustChangePassword();
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.root}>
      <form className={styles.card} onSubmit={handleSubmit}>
        <h1 className={styles.title}>Change Password</h1>
        <p className={styles.subtitle}>
          You are using the default password. Please set a new password to continue.
        </p>
        <div className={styles.field}>
          <label className={styles.label}>Current Password</label>
          <input
            className={styles.input}
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
            autoFocus
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>New Password (min 8 characters)</label>
          <input
            className={styles.input}
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Confirm New Password</label>
          <input
            className={styles.input}
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
          />
        </div>
        <button className={styles.button} type="submit" disabled={loading || !currentPassword || !newPassword || !confirmPassword}>
          {loading ? 'Updating...' : 'Update Password'}
        </button>
        {error && <p className={styles.error}>{error}</p>}
      </form>
    </div>
  );
}
