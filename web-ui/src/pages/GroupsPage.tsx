import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { makeStyles } from '@fluentui/react-components';
import { useGroups } from '../hooks/useGroups';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/Card';
import { Spinner } from '../components/ui/Spinner';
import { EmptyState } from '../components/ui/EmptyState';
import type { GroupInput } from '../types/api';

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
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
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
  cardDesc: {
    margin: '0 0 0.75rem',
    fontSize: '0.875rem',
    color: '#888',
    lineHeight: '1.4',
  },
  cardMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    marginBottom: '1rem',
  },
  deviceCount: {
    fontSize: '0.75rem',
    color: '#888',
  },
  policyBadge: {
    fontSize: '0.75rem',
    padding: '0.125rem 0.5rem',
    backgroundColor: 'rgba(233, 69, 96, 0.2)',
    color: '#e94560',
    borderRadius: '4px',
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
    minHeight: '80px',
    ':focus': {
      outline: 'none',
      border: '1px solid #e94560',
    },
  },
  formActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '0.75rem',
    marginTop: '0.5rem',
  },
});

export function GroupsPage() {
  const styles = useStyles();
  const navigate = useNavigate();
  const { groups, loading, error, createGroup, deleteGroup, refresh } = useGroups();
  const [showCreate, setShowCreate] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupDesc, setNewGroupDesc] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newGroupName.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const input: GroupInput = {
        name: newGroupName.trim(),
        description: newGroupDesc.trim() || undefined,
      };
      await createGroup(input);
      setNewGroupName('');
      setNewGroupDesc('');
      setShowCreate(false);
    } catch (err) {
      console.error('Failed to create group:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteGroup = async (id: string) => {
    if (!confirm('Are you sure you want to delete this group?')) return;
    try {
      await deleteGroup(id);
    } catch (err) {
      console.error('Failed to delete group:', err);
    }
  };

  if (loading) {
    return (
      <div className={styles.root}>
        <div className={styles.loading}>
          <Spinner size="lg" />
          <p>Loading groups...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.root}>
        <EmptyState
          title="Error loading groups"
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
          <h1 className={styles.headerTitle}>Device Groups</h1>
          <p className={styles.subtitle}>
            Organize devices into groups for easier management
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)}>+ Create Group</Button>
      </div>

      {groups.length === 0 ? (
        <EmptyState
          title="No groups created"
          description="Create your first group to organize devices"
          action={
            <Button onClick={() => setShowCreate(true)}>Create Group</Button>
          }
        />
      ) : (
        <div className={styles.grid}>
          {groups.map((group) => (
            <Card key={group.id} className={styles.card}>
              <CardHeader>
                <CardTitle>{group.name}</CardTitle>
              </CardHeader>
              <CardContent>
                {group.description && (
                  <p className={styles.cardDesc}>{group.description}</p>
                )}
                <div className={styles.cardMeta}>
                  <span className={styles.deviceCount}>
                    {group.deviceCount ?? 0} devices
                  </span>
                  {group.policyId && (
                    <span className={styles.policyBadge}>Has Policy</span>
                  )}
                </div>
                <div className={styles.cardActions}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => navigate(`/groups/${group.id}`)}
                  >
                    View Details
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDeleteGroup(group.id)}
                  >
                    Delete
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Create Group"
      >
        <form onSubmit={handleCreateGroup} className={styles.form}>
          <div className={styles.formField}>
            <label htmlFor="groupName" className={styles.formLabel}>Group Name *</label>
            <input
              id="groupName"
              type="text"
              placeholder="Enter group name"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              className={styles.input}
              autoFocus
              required
            />
          </div>
          <div className={styles.formField}>
            <label htmlFor="groupDesc" className={styles.formLabel}>Description</label>
            <textarea
              id="groupDesc"
              placeholder="Optional description"
              value={newGroupDesc}
              onChange={(e) => setNewGroupDesc(e.target.value)}
              className={styles.textarea}
              rows={3}
            />
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
              Create Group
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
