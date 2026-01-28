// Device hooks
export { useDevices, useDevice } from './useDevices';

// Telemetry hooks
export { useTelemetry, useTelemetryHistory, useAllTelemetry } from './useTelemetry';

// Group hooks
export { useGroups, useGroup } from './useGroups';

// Policy hooks
export { usePolicies, usePolicy } from './usePolicies';

// Event hooks
export { useEvents, useDeviceEvents, useEventStats } from './useEvents';

// App hooks
export { useDeviceApps, useAppCatalog, useAppDetails } from './useApps';

// Audit hooks
export { useAudit, useDeviceAudit } from './useAudit';

// Command hooks
export { useCommands, useDeviceCommands, CommandHelpers } from './useCommands';

// WebSocket hooks
export {
  useAdminWebSocket,
  useAdminEvent,
  useRealtimeDeviceStatus,
  useRealtimeEvents,
} from './useAdminWebSocket';

// MDM command hooks
export { useMdmCommands } from './useMdmCommands';

// WebRTC hooks
export { useWebRTC } from './useWebRTC';
