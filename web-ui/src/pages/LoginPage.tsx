import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { makeStyles } from '@fluentui/react-components';
import { useAuth } from '../hooks/useAuth';

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
    color: '#888',
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
});

export function LoginPage() {
  const styles = useStyles();
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(username, password);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.root}>
      <form className={styles.card} onSubmit={handleSubmit}>
        <h1 className={styles.title}>Android Remote</h1>
        <p className={styles.subtitle}>Sign in to the admin console</p>
        <div className={styles.field}>
          <label className={styles.label}>Username</label>
          <input
            className={styles.input}
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Password</label>
          <input
            className={styles.input}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        <button className={styles.button} type="submit" disabled={loading || !username || !password}>
          {loading ? 'Signing in...' : 'Sign In'}
        </button>
        {error && <p className={styles.error}>{error}</p>}
      </form>
    </div>
  );
}
