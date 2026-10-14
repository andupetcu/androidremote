import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import * as appPackageStore from '../services/appPackageStore';
import { getStorageProvider } from '../services/storageProvider';
import { getPublicBaseUrl } from '../services/baseUrl';

/** The agent (device owner) package that QR provisioning installs. */
export function agentPackageName(): string {
  return process.env.AGENT_PACKAGE_NAME || 'com.androidremote.app';
}

const DOWNLOAD_PATH = '/api/provisioning/agent.apk';

const downloadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many download requests, please try again later' },
});

function currentAgentApk(): { fullPath: string; sha256: string; pkg: appPackageStore.AppPackage } | null {
  const pkg = appPackageStore.getAppPackageByName(agentPackageName());
  if (!pkg) return null;
  const sha256 = appPackageStore.ensurePackageSha256(pkg);
  const storage = getStorageProvider() as { getFullPath?: (p: string) => string };
  if (!sha256 || !storage.getFullPath) return null;
  try {
    return { fullPath: storage.getFullPath(pkg.filePath), sha256, pkg };
  } catch {
    return null;
  }
}

/** Android wants the checksum as unpadded base64url of the raw SHA-256 bytes. */
export function checksumBase64Url(sha256Hex: string): string {
  return Buffer.from(sha256Hex, 'hex').toString('base64url');
}

/**
 * Public, narrow download for a factory-fresh device that scans the provisioning QR code (it has no token yet):
 * only the configured agent package, nothing else. Every other upload stays behind authentication.
 */
export const provisioningPublicRouter = Router();
provisioningPublicRouter.get('/provisioning/agent.apk', downloadLimiter, (_req: Request, res: Response) => {
  const apk = currentAgentApk();
  if (!apk) {
    res.status(404).json({ error: 'No agent APK has been uploaded' });
    return;
  }
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', `attachment; filename="${apk.pkg.packageName}.apk"`);
  res.setHeader('X-Content-SHA256', apk.sha256);
  res.sendFile(apk.fullPath, { dotfiles: 'deny' }, err => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Not found' });
  });
});

/** Admin: the data for the provisioning QR code, using the public download above. */
export const provisioningAdminRouter = Router();
provisioningAdminRouter.get('/provisioning/info', (_req: Request, res: Response) => {
  const apk = currentAgentApk();
  const downloadUrl = `${getPublicBaseUrl()}${DOWNLOAD_PATH}`;
  const packageName = agentPackageName();
  if (!apk) {
    res.json({ available: false, packageName, downloadUrl, sha256: null, checksum: null, qrPayload: null });
    return;
  }
  const checksum = checksumBase64Url(apk.sha256);
  res.json({
    available: true,
    packageName,
    versionName: apk.pkg.versionName,
    downloadUrl,
    sha256: apk.sha256,
    checksum,
    qrPayload: {
      'android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME': `${packageName}/.admin.DeviceOwnerReceiver`,
      'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION': downloadUrl,
      'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_CHECKSUM': checksum,
      'android.app.extra.PROVISIONING_SKIP_EDUCATION_SCREENS': true,
      'android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED': true,
    },
  });
});
