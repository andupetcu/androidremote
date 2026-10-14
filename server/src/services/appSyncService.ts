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
  // Optional maintenance window for app updates, "HH:mm" (AM-08). Absent means install immediately.
  const start = settingsStore.get('updateWindowStart');
  const end = settingsStore.get('updateWindowEnd');
  if (start && end) payload.updateWindow = { start, end };
  return commandStore.queueCommand(deviceId, 'SYNC_POLICY', payload, { supersede: 'type' });
}
