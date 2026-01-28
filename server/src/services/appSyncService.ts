import { policyStore, Policy, RequiredAppConfig } from './policyStore';
import { commandStore } from './commandStore';
import { getAppPackageByName, AppPackage } from './appPackageStore';
import { getDatabase } from '../db/connection';

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
      commandStore.queueCommand(deviceId, 'INSTALL_APK', {
        url: pkg.downloadUrl,
        packageName: pkg.packageName,
        autoStartAfterInstall: appConfig.autoStartAfterInstall || false,
        foregroundApp: appConfig.foregroundApp || false,
        autoStartOnBoot: appConfig.autoStartOnBoot || false,
      });
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
  const db = getDatabase();

  // Get all devices with this policy
  const devices = db.prepare(`
    SELECT id FROM devices WHERE policy_id = ?
  `).all(policyId) as { id: string }[];

  let totalCommands = 0;
  for (const device of devices) {
    totalCommands += syncRequiredApps(device.id, policyId);
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
