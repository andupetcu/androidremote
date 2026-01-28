import { useCallback } from 'react';
import type { DeviceInfo, AppList, UseWebRTCResult } from './useWebRTC';

/**
 * Hook for MDM (Mobile Device Management) commands.
 * Provides typed methods for interacting with device management features.
 */
export function useMdmCommands(webrtc: Pick<UseWebRTCResult, 'sendCommand' | 'sendCommandWithResponse'>) {
  const { sendCommand, sendCommandWithResponse } = webrtc;

  /**
   * Get comprehensive device information including battery, storage, and MDM status.
   */
  const getDeviceInfo = useCallback(async (): Promise<DeviceInfo | null> => {
    return sendCommandWithResponse<DeviceInfo>({ type: 'GET_DEVICE_INFO' });
  }, [sendCommandWithResponse]);

  /**
   * Lock the device screen immediately.
   * Requires Device Admin or Device Owner privileges on the device.
   */
  const lockDevice = useCallback(async (): Promise<void> => {
    await sendCommandWithResponse({ type: 'LOCK_DEVICE' });
  }, [sendCommandWithResponse]);

  /**
   * Reboot the device.
   * Requires Device Owner privileges on Android 7.0+.
   */
  const rebootDevice = useCallback(async (): Promise<void> => {
    await sendCommandWithResponse({ type: 'REBOOT_DEVICE' });
  }, [sendCommandWithResponse]);

  /**
   * Factory reset the device. USE WITH EXTREME CAUTION.
   * Requires Device Owner privileges.
   *
   * @param wipeExternalStorage Also wipe external storage (SD card)
   */
  const wipeDevice = useCallback(async (wipeExternalStorage = false): Promise<void> => {
    await sendCommandWithResponse({ type: 'WIPE_DEVICE', wipeExternalStorage });
  }, [sendCommandWithResponse]);

  /**
   * List installed applications on the device.
   *
   * @param includeSystemApps Include system apps in the list
   */
  const listApps = useCallback(async (includeSystemApps = false): Promise<AppList | null> => {
    return sendCommandWithResponse<AppList>({ type: 'LIST_APPS', includeSystemApps });
  }, [sendCommandWithResponse]);

  /**
   * Install an app from a URL.
   * Requires Device Owner privileges.
   *
   * @param packageName Expected package name
   * @param apkUrl URL to download the APK from
   */
  const installApp = useCallback(async (packageName: string, apkUrl: string): Promise<void> => {
    await sendCommandWithResponse({ type: 'INSTALL_APP', packageName, apkUrl });
  }, [sendCommandWithResponse]);

  /**
   * Uninstall an app by package name.
   * Requires Device Owner privileges.
   *
   * @param packageName Package name to uninstall
   */
  const uninstallApp = useCallback(async (packageName: string): Promise<void> => {
    await sendCommandWithResponse({ type: 'UNINSTALL_APP', packageName });
  }, [sendCommandWithResponse]);

  /**
   * Send lock device command without waiting for response (fire and forget).
   */
  const lockDeviceSync = useCallback(() => {
    sendCommand({ type: 'LOCK_DEVICE' });
  }, [sendCommand]);

  return {
    // Async methods with response
    getDeviceInfo,
    lockDevice,
    rebootDevice,
    wipeDevice,
    listApps,
    installApp,
    uninstallApp,
    // Fire-and-forget methods
    lockDeviceSync,
  };
}

export type MdmCommands = ReturnType<typeof useMdmCommands>;
