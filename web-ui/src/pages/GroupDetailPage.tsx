import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { makeStyles } from '@fluentui/react-components';
import { useGroup, useGroups } from '../hooks/useGroups';
import { useDevices } from '../hooks/useDevices';
import { usePolicies } from '../hooks/usePolicies';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { Modal } from '../components/ui/Modal';
import { Spinner } from '../components/ui/Spinner';
import { EmptyState } from '../components/ui/EmptyState';
import { DataTable } from '../components/data/DataTable';
import type { Column } from '../components/data/DataTable';
import type { Device } from '../types/api';

const useStyles = makeStyles({
  root: {
    padding: '1.5rem',
    maxWidth: '1200px',
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
  infoTitle: {
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
  },
  metaLink: {
    color: '#e94560',
    textDecoration: 'none',
    ':hover': {
      textDecoration: 'underline',
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
  section: {
    marginBottom: '2rem',
  },
  sectionTitle: {
    margin: '0 0 1rem',
    fontSize: '1.25rem',
    color: '#fff',
  },
  deviceLink: {
    color: '#e94560',
    textDecoration: 'none',
    fontWeight: '500',
    ':hover': {
      textDecoration: 'underline',
    },
  },
  date: {
    fontSize: '0.875rem',
    color: '#888',
  },
  addDevice: {
    minHeight: '200px',
  },
  noDevices: {
    textAlign: 'center',
    color: '#888',
    padding: '2rem',
  },
  deviceList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    maxHeight: '400px',
    overflowY: 'auto',
  },
  deviceItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.75rem 1rem',
    backgroundColor: '#16213e',
    border: '1px solid #0f3460',
    borderRadius: '0.5rem',
  },
  deviceInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
  },
  deviceName: {
    fontWeight: '500',
    color: '#fff',
  },
  deviceModel: {
    fontSize: '0.875rem',
    color: '#666',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  formField: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  formLabel: {
    fontSize: '0.875rem',
    color: '#888',
  },
  input: {
    backgroundColor: '#16213e',
    border: '1px solid #0f3460',
    borderRadius: '0.375rem',
    padding: '0.75rem',
    color: '#eee',
    fontSize: '0.875rem',
    ':focus': {
      outline: 'none',
      border: '1px solid #e94560',
    },
  },
  textarea: {
    backgroundColor: '#16213e',
    border: '1px solid #0f3460',
    borderRadius: '0.375rem',
    padding: '0.75rem',
    color: '#eee',
    fontSize: '0.875rem',
    ':focus': {
      outline: 'none',
      border: '1px solid #e94560',
    },
  },
  select: {
    backgroundColor: '#16213e',
    border: '1px solid #0f3460',
    borderRadius: '0.375rem',
    padding: '0.75rem',
    color: '#eee',
    fontSize: '0.875rem',
    ':focus': {
      outline: 'none',
      border: '1px solid #e94560',
    },
  },
  formActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '0.5rem',
    marginTop: '0.5rem',
  },
});

export function GroupDetailPage() {
  const styles = useStyles();
  const { groupId } = useParams<{ groupId: string }>();
  const navigate = useNavigate();
  const { group, devices, loading, error, refresh, addDevice, removeDevice } = useGroup(groupId || '');
  const { updateGroup } = useGroups();
  const { devices: allDevices } = useDevices();
  const { policies } = usePolicies();

  const [showAddDevice, setShowAddDevice] = useState(false);
  const [showEditGroup, setShowEditGroup] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editPolicyId, setEditPolicyId] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const availableDevices = allDevices.filter(
    (d) => !devices.some((gd) => gd.id === d.id)
  );

  const handleAddDevice = async (deviceId: string) => {
    try {
      await addDevice(deviceId);
      setShowAddDevice(false);
    } catch (err) {
      console.error('Failed to add device:', err);
    }
  };

  const handleRemoveDevice = async (deviceId: string) => {
    if (!confirm('Remove this device from the group?')) return;
    try {
      await removeDevice(deviceId);
    } catch (err) {
      console.error('Failed to remove device:', err);
    }
  };

  const openEditModal = () => {
    if (group) {
      setEditName(group.name);
      setEditDesc(group.description || '');
      setEditPolicyId(group.policyId || '');
      setShowEditGroup(true);
    }
  };

  const handleEditGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!groupId || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await updateGroup(groupId, {
        name: editName.trim(),
        description: editDesc.trim() || undefined,
        policyId: editPolicyId || undefined,
      });
      setShowEditGroup(false);
      await refresh();
    } catch (err) {
      console.error('Failed to update group:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const columns: Column<Device>[] = [
    {
      key: 'status',
      header: 'Status',
      render: (device) => (
        <Badge variant={device.status === 'online' ? 'success' : 'warning'} size="sm">
          {device.status}
        </Badge>
      ),
    },
    {
      key: 'name',
      header: 'Device Name',
      render: (device) => (
        <Link to={`/devices/${device.id}`} className={styles.deviceLink}>
          {device.name}
        </Link>
      ),
    },
    {
      key: 'model',
      header: 'Model',
      render: (device) => <span>{device.model || '-'}</span>,
    },
    {
      key: 'lastSeenAt',
      header: 'Last Seen',
      render: (device) => (
        <span className={styles.date}>
          {device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : 'Never'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (device) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => handleRemoveDevice(device.id)}
        >
          Remove
        </Button>
      ),
    },
  ];

  if (loading) {
    return (
      <div className={styles.root}>
        <div className={styles.loading}>
          <Spinner size="lg" />
          <p>Loading group...</p>
        </div>
      </div>
    );
  }

  if (error || !group) {
    return (
      <div className={styles.root}>
        <EmptyState
          title="Group not found"
          description={error || 'The requested group does not exist.'}
          action={
            <Button onClick={() => navigate('/groups')}>Back to Groups</Button>
          }
        />
      </div>
    );
  }

  const assignedPolicy = policies.find((p) => p.id === group.policyId);

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.nav}>
          <Button variant="ghost" onClick={() => navigate('/groups')}>
            &larr; Back to Groups
          </Button>
        </div>

        <div className={styles.info}>
          <h1 className={styles.infoTitle}>{group.name}</h1>
          {group.description && (
            <p className={styles.description}>{group.description}</p>
          )}
          <div className={styles.meta}>
            <span>{devices.length} devices</span>
            {assignedPolicy && (
              <span>
                Policy:{' '}
                <Link to={`/policies/${assignedPolicy.id}`} className={styles.metaLink}>
                  {assignedPolicy.name}
                </Link>
              </span>
            )}
          </div>
        </div>

        <div className={styles.actions}>
          <Button variant="secondary" onClick={openEditModal}>
            Edit Group
          </Button>
          <Button onClick={() => setShowAddDevice(true)}>
            + Add Device
          </Button>
        </div>
      </header>

      <main>
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Devices in Group</h2>
          {devices.length === 0 ? (
            <EmptyState
              title="No devices"
              description="Add devices to this group to manage them together"
              action={
                <Button onClick={() => setShowAddDevice(true)}>
                  Add Device
                </Button>
              }
            />
          ) : (
            <DataTable
              columns={columns}
              data={devices}
              keyExtractor={(d) => d.id}
            />
          )}
        </div>
      </main>

      {/* Add Device Modal */}
      <Modal
        open={showAddDevice}
        onClose={() => setShowAddDevice(false)}
        title="Add Device to Group"
      >
        <div className={styles.addDevice}>
          {availableDevices.length === 0 ? (
            <p className={styles.noDevices}>
              All devices are already in this group
            </p>
          ) : (
            <div className={styles.deviceList}>
              {availableDevices.map((device) => (
                <div key={device.id} className={styles.deviceItem}>
                  <div className={styles.deviceInfo}>
                    <Badge
                      variant={device.status === 'online' ? 'success' : 'warning'}
                      size="sm"
                    >
                      {device.status}
                    </Badge>
                    <span className={styles.deviceName}>{device.name}</span>
                    <span className={styles.deviceModel}>
                      {device.model || 'Unknown model'}
                    </span>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleAddDevice(device.id)}
                  >
                    Add
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>

      {/* Edit Group Modal */}
      <Modal
        open={showEditGroup}
        onClose={() => setShowEditGroup(false)}
        title="Edit Group"
      >
        <form onSubmit={handleEditGroup} className={styles.form}>
          <div className={styles.formField}>
            <label htmlFor="editName" className={styles.formLabel}>Group Name *</label>
            <input
              id="editName"
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className={styles.input}
              required
            />
          </div>
          <div className={styles.formField}>
            <label htmlFor="editDesc" className={styles.formLabel}>Description</label>
            <textarea
              id="editDesc"
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
              className={styles.textarea}
              rows={3}
            />
          </div>
          <div className={styles.formField}>
            <label htmlFor="editPolicy" className={styles.formLabel}>Assigned Policy</label>
            <select
              id="editPolicy"
              value={editPolicyId}
              onChange={(e) => setEditPolicyId(e.target.value)}
              className={styles.select}
            >
              <option value="">No policy</option>
              {policies.map((policy) => (
                <option key={policy.id} value={policy.id}>
                  {policy.name}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.formActions}>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setShowEditGroup(false)}
            >
              Cancel
            </Button>
            <Button type="submit" loading={isSubmitting}>
              Save Changes
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
