import { policyStore, Policy, RequiredAppConfig } from './policyStore';
import { commandStore } from './commandStore';
import { settingsStore } from './settingsStore';
import { getAppPackageByName, ensurePackageSha256, AppPackage } from './appPackageStore';

/**
 * Sync required apps for a device based on its policy
 * Queues INSTALL_APK commands for each required app that has an uploaded package
 */
export function syncRequiredApps(deviceId: string, policyId: string): number {
  const policy = policyStore.getPolicy(policyId);
  if (!policy) {
    return 0;
  }

  const requiredApps = policy.requiredApps || [];
  let commandsQueued = 0;

  for (const appConfig of requiredApps) {
    const pkg = getAppPackageByName(appConfig.packageName);
    if (pkg && pkg.downloadUrl) {
      const sha256 = ensurePackageSha256(pkg);
      if (!sha256) {
        console.warn(`[policy-sync] ${pkg.packageName}: APK file unreadable, no sha256, install not queued`);
        continue;
      }
      // One pending install per device and package: a policy edited five times queues one download (SR-18).
      commandStore.queueCommand(deviceId, 'INSTALL_APK', {
        url: pkg.downloadUrl,
        packageName: pkg.packageName,
        sha256,
        autoStartAfterInstall: appConfig.autoStartAfterInstall || false,
        foregroundApp: appConfig.foregroundApp || false,
        autoStartOnBoot: appConfig.autoStartOnBoot || false,
      }, { supersede: 'packageName' });
      commandsQueued++;
    }
  }

  return commandsQueued;
}

/**
 * Sync required apps for all devices with a specific policy
 * Used when a policy's requiredApps field changes
 */
export function syncPolicyRequiredApps(policyId: string): number {
  let totalCommands = 0;
  for (const deviceId of policyStore.getDeviceIdsForPolicy(policyId)) {
    totalCommands += syncRequiredApps(deviceId, policyId);
  }

  return totalCommands;
}

/**
 * Get required apps for a policy with their package info
 * Returns which packages are available vs missing
 */
export function getRequiredAppsStatus(policyId: string): {
  available: AppPackage[];
  missing: string[];
} {
  const policy = policyStore.getPolicy(policyId);
  if (!policy) {
    return { available: [], missing: [] };
  }

  const requiredApps = policy.requiredApps || [];
  const available: AppPackage[] = [];
  const missing: string[] = [];

  for (const appConfig of requiredApps) {
    const pkg = getAppPackageByName(appConfig.packageName);
    if (pkg) {
      available.push(pkg);
    } else {
      missing.push(appConfig.packageName);
    }
  }

  return { available, missing };
}

/**
 * Queue the full policy for a device. An older SYNC_POLICY still waiting for the device is superseded,
 * so a device that was offline during several edits receives one command (SR-18).
 */
export function queueSyncPolicy(deviceId: string, policy: Policy) {
  const payload: Record<string, unknown> = {
    silentMode: policy.silentMode,
    kioskMode: policy.kioskMode,
    requiredApps: policy.requiredApps || [],
  };
  // Maintenance window for app updates, "HH:mm" (AM-08). Always sent: null tells the device to drop an older
  // window (a missing key would leave it in place), meaning install immediately.
  const start = settingsStore.get('updateWindowStart');
  const end = settingsStore.get('updateWindowEnd');
  payload.updateWindow = start && end ? { start, end } : null;
  return commandStore.queueCommand(deviceId, 'SYNC_POLICY', payload, { supersede: 'type' });
}

/**
 * Turn the policy's kiosk setting into a SET_KIOSK command (the device never acts on kioskMode inside SYNC_POLICY).
 * An older SET_KIOSK still waiting for the device is superseded. Policies have no lock-task field, so lockTask is
 * always true. Returns null when there is nothing to send: no package to target (kiosk needs one), or kiosk off
 * with no package known (nothing was ever started from this policy).
 * `fallbackPackage` names the kiosk app to release when the device moves off a kiosk policy.
 */
export function queueKioskCommand(deviceId: string, policy: Policy | null, fallbackPackage?: string | null) {
  const enabled = !!policy?.kioskMode;
  const packageName = enabled ? policy!.kioskPackage : (policy?.kioskPackage || fallbackPackage || null);
  if (!packageName) return null;
  return commandStore.queueCommand(deviceId, 'SET_KIOSK', { packageName, enabled, lockTask: true }, { supersede: 'type' });
}
