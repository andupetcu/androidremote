import type { CommandType } from '../types/api';

/**
 * Command types the Android agent dispatches. Mirrors the `when (command.type)` in
 * app/src/main/kotlin/com/androidremote/app/mdm/CommandPollingService.kt; anything else the
 * server enum accepts is answered "Unknown command type" by the agent (UNLOCK, SEND_MESSAGE,
 * PLAY_SOUND, SET_BRIGHTNESS, RUN_SHELL, the file commands, ...). Keep in sync with the agent.
 */
export const ANDROID_COMMAND_TYPES: ReadonlySet<CommandType> = new Set<CommandType>([
  'INSTALL_APK', 'UNINSTALL_APP', 'LOCK', 'REBOOT', 'WIPE',
  'SET_KIOSK', 'DISABLE_APP', 'ENABLE_APP', 'LAUNCH_APP', 'GRANT_PERMISSION', 'SET_PROTECTED_PACKAGES',
  'START_REMOTE', 'TAKE_SCREENSHOT', 'GET_LOCATION', 'REFRESH_TELEMETRY', 'SYNC_APPS', 'SYNC_POLICY', 'SET_VOLUME',
]);

export const ANDROID_UNSUPPORTED_HINT = 'Not supported by the Android agent';

/** Devices that report no OS are Android (the original and still the main agent). */
export function isAndroid(osType?: string | null): boolean {
  return !osType || osType === 'android';
}

/** Whether a command type may be offered as a working action for this device's agent. */
export function isCommandSupported(osType: string | null | undefined, type: CommandType): boolean {
  return !isAndroid(osType) || ANDROID_COMMAND_TYPES.has(type);
}
