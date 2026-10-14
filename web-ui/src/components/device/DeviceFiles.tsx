import { EmptyState } from '../ui/EmptyState';
import './DeviceComponents.css';

interface DeviceFilesProps {
  deviceId: string;
}

// deviceId is accepted for the planned file browser; the placeholder does not use it yet.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function DeviceFiles(_props: DeviceFilesProps) {
  return (
    <div className="device-files">
      <EmptyState
        title="File Browser"
        description="File browser is planned for a future release."
      />
    </div>
  );
}
