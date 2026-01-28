import { EmptyState } from '../ui/EmptyState';
import './DeviceComponents.css';

interface DeviceFilesProps {
  deviceId: string;
}

export function DeviceFiles({ deviceId }: DeviceFilesProps) {
  // File browser functionality would require server-side file listing API
  // This is a placeholder for future implementation

  return (
    <div className="device-files">
      <EmptyState
        title="File Browser"
        description="File transfer functionality is not yet available for this device"
      />
      <div className="device-files__info">
        <p>Device ID: {deviceId}</p>
        <p>Future features:</p>
        <ul>
          <li>Browse device storage</li>
          <li>Upload files to device</li>
          <li>Download files from device</li>
          <li>Delete files</li>
        </ul>
      </div>
    </div>
  );
}
