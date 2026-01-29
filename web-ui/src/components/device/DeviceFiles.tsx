import { EmptyState } from '../ui/EmptyState';
import './DeviceComponents.css';

interface DeviceFilesProps {
  deviceId: string;
}

export function DeviceFiles({ deviceId: _deviceId }: DeviceFilesProps) {
  return (
    <div className="device-files">
      <EmptyState
        title="File Browser"
        description="File browser is planned for a future release."
      />
    </div>
  );
}
