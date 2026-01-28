import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { makeStyles, mergeClasses } from '@fluentui/react-components';
import { usePolicies } from '../hooks/usePolicies';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { Badge } from '../components/ui/Badge';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/Card';
import { Spinner } from '../components/ui/Spinner';
import { EmptyState } from '../components/ui/EmptyState';
import type { PolicyInput } from '../types/api';

const useStyles = makeStyles({
  root: {
    padding: '1.5rem',
    maxWidth: '1200px',
    margin: '0 auto',
    '@media (max-width: 640px)': {
      padding: '1rem',
    },
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: '1.5rem',
    '@media (max-width: 640px)': {
      flexDirection: 'column',
      gap: '1rem',
    },
  },
  headerTitle: {
    margin: 0,
    fontSize: '1.75rem',
    color: '#fff',
  },
  subtitle: {
    margin: '0.25rem 0 0',
    color: '#888',
    fontSize: '0.875rem',
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
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
    gap: '1rem',
    '@media (max-width: 640px)': {
      gridTemplateColumns: '1fr',
    },
  },
  card: {
    transitionProperty: 'border-color',
    transitionDuration: '0.2s',
    ':hover': {
      border: '1px solid #e94560',
    },
  },
  cardHeaderInner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.5rem',
  },
  cardDesc: {
    margin: '0 0 0.75rem',
    fontSize: '0.875rem',
    color: '#888',
    lineHeight: '1.4',
  },
  settings: {
    display: 'flex',
    gap: '0.5rem',
    flexWrap: 'wrap',
    marginBottom: '1rem',
  },
  setting: {
    fontSize: '0.75rem',
    padding: '0.25rem 0.5rem',
    borderRadius: '0.25rem',
    backgroundColor: '#0f3460',
    color: '#888',
  },
  settingActive: {
    backgroundColor: 'rgba(74, 222, 128, 0.2)',
    color: '#4ade80',
  },
  cardActions: {
    display: 'flex',
    gap: '0.5rem',
    paddingTop: '0.75rem',
    borderTop: '1px solid rgba(255, 255, 255, 0.1)',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  formField: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
  },
  formLabel: {
    fontSize: '0.875rem',
    color: '#888',
  },
  input: {
    backgroundColor: '#1a1a2e',
    border: '1px solid #0f3460',
    borderRadius: '0.375rem',
    padding: '0.625rem 0.875rem',
    color: '#eee',
    fontSize: '0.875rem',
    fontFamily: 'inherit',
    ':focus': {
      outline: 'none',
      border: '1px solid #e94560',
    },
  },
  textarea: {
    backgroundColor: '#1a1a2e',
    border: '1px solid #0f3460',
    borderRadius: '0.375rem',
    padding: '0.625rem 0.875rem',
    color: '#eee',
    fontSize: '0.875rem',
    fontFamily: 'inherit',
    resize: 'vertical',
    minHeight: '60px',
    ':focus': {
      outline: 'none',
      border: '1px solid #e94560',
    },
  },
  formSection: {
    marginTop: '0.5rem',
  },
  formSectionTitle: {
    margin: '0 0 0.75rem',
    fontSize: '0.875rem',
    color: '#fff',
  },
  checkbox: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.375rem 0',
    cursor: 'pointer',
    fontSize: '0.875rem',
    color: '#ccc',
  },
  checkboxInput: {
    accentColor: '#e94560',
  },
  formActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '0.75rem',
    marginTop: '0.5rem',
  },
});

export function PoliciesPage() {
  const styles = useStyles();
  const navigate = useNavigate();
  const { policies, loading, error, createPolicy, deletePolicy, refresh } = usePolicies();
  const [showCreate, setShowCreate] = useState(false);
  const [formData, setFormData] = useState<PolicyInput>({
    name: '',
    description: '',
    kioskMode: false,
    playStoreEnabled: true,
    cameraEnabled: true,
    adbEnabled: false,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleCreatePolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await createPolicy({
        ...formData,
        name: formData.name.trim(),
        description: formData.description?.trim() || undefined,
      });
      setFormData({
        name: '',
        description: '',
        kioskMode: false,
        playStoreEnabled: true,
        cameraEnabled: true,
        adbEnabled: false,
      });
      setShowCreate(false);
    } catch (err) {
      console.error('Failed to create policy:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeletePolicy = async (id: string) => {
    if (!confirm('Are you sure you want to delete this policy?')) return;
    try {
      await deletePolicy(id);
    } catch (err) {
      console.error('Failed to delete policy:', err);
    }
  };

  if (loading) {
    return (
      <div className={styles.root}>
        <div className={styles.loading}>
          <Spinner size="lg" />
          <p>Loading policies...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.root}>
        <EmptyState
          title="Error loading policies"
          description={error}
          action={<Button onClick={refresh}>Retry</Button>}
        />
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.headerTitle}>Policies</h1>
          <p className={styles.subtitle}>
            Define security and configuration policies for devices
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)}>+ Create Policy</Button>
      </div>

      {policies.length === 0 ? (
        <EmptyState
          title="No policies created"
          description="Create your first policy to manage device configurations"
          action={
            <Button onClick={() => setShowCreate(true)}>Create Policy</Button>
          }
        />
      ) : (
        <div className={styles.grid}>
          {policies.map((policy) => (
            <Card key={policy.id} className={styles.card}>
              <CardHeader>
                <div className={styles.cardHeaderInner}>
                  <CardTitle>{policy.name}</CardTitle>
                  {policy.isDefault && (
                    <Badge variant="success" size="sm">Default</Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {policy.description && (
                  <p className={styles.cardDesc}>{policy.description}</p>
                )}
                <div className={styles.settings}>
                  <span className={mergeClasses(styles.setting, policy.kioskMode && styles.settingActive)}>
                    Kiosk: {policy.kioskMode ? 'On' : 'Off'}
                  </span>
                  <span className={mergeClasses(styles.setting, policy.playStoreEnabled && styles.settingActive)}>
                    Play Store: {policy.playStoreEnabled ? 'On' : 'Off'}
                  </span>
                  <span className={mergeClasses(styles.setting, policy.cameraEnabled && styles.settingActive)}>
                    Camera: {policy.cameraEnabled ? 'On' : 'Off'}
                  </span>
                  <span className={mergeClasses(styles.setting, !policy.adbEnabled && styles.settingActive)}>
                    ADB: {policy.adbEnabled ? 'On' : 'Off'}
                  </span>
                </div>
                <div className={styles.cardActions}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => navigate(`/policies/${policy.id}`)}
                  >
                    Edit
                  </Button>
                  {!policy.isDefault && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeletePolicy(policy.id)}
                    >
                      Delete
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Create Policy"
      >
        <form onSubmit={handleCreatePolicy} className={styles.form}>
          <div className={styles.formField}>
            <label htmlFor="policyName" className={styles.formLabel}>Policy Name *</label>
            <input
              id="policyName"
              type="text"
              placeholder="Enter policy name"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              className={styles.input}
              autoFocus
              required
            />
          </div>
          <div className={styles.formField}>
            <label htmlFor="policyDesc" className={styles.formLabel}>Description</label>
            <textarea
              id="policyDesc"
              placeholder="Optional description"
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              className={styles.textarea}
              rows={2}
            />
          </div>

          <div className={styles.formSection}>
            <h4 className={styles.formSectionTitle}>Settings</h4>
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={formData.kioskMode}
                onChange={(e) => setFormData({ ...formData, kioskMode: e.target.checked })}
                className={styles.checkboxInput}
              />
              <span>Kiosk Mode</span>
            </label>
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={formData.playStoreEnabled}
                onChange={(e) => setFormData({ ...formData, playStoreEnabled: e.target.checked })}
                className={styles.checkboxInput}
              />
              <span>Enable Play Store</span>
            </label>
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={formData.cameraEnabled}
                onChange={(e) => setFormData({ ...formData, cameraEnabled: e.target.checked })}
                className={styles.checkboxInput}
              />
              <span>Enable Camera</span>
            </label>
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={formData.adbEnabled}
                onChange={(e) => setFormData({ ...formData, adbEnabled: e.target.checked })}
                className={styles.checkboxInput}
              />
              <span>Enable ADB</span>
            </label>
          </div>

          <div className={styles.formActions}>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setShowCreate(false)}
            >
              Cancel
            </Button>
            <Button type="submit" loading={isSubmitting}>
              Create Policy
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
