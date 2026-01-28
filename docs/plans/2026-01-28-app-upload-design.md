# App Upload & Installation Feature Design

## Overview

Enable admins to upload APK files and install them on managed devices, either manually (select devices) or automatically (policy-based).

## Requirements

1. **Multiple device install** - Upload APK from Apps page, select which devices to install on
2. **Policy-based auto-install** - Devices with certain policies auto-install required apps
3. **Auto-sync triggers** - Install on enrollment AND when policy changes
4. **Pluggable storage** - Start with local filesystem, design for easy swap to S3/cloud

## Data Model

### New table: `app_packages`

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT | Primary key (UUID) |
| packageName | TEXT | Android package name (unique) |
| appName | TEXT | Display name |
| versionName | TEXT | Version string |
| versionCode | INTEGER | Version code |
| fileSize | INTEGER | File size in bytes |
| filePath | TEXT | Relative path to stored file |
| uploadedAt | INTEGER | Timestamp |
| uploadedBy | TEXT | Admin identifier |

### Policy extension

Add `requiredApps` column (TEXT, JSON array of package names) to `policies` table.

## Storage Abstraction

```typescript
interface StorageProvider {
  save(filename: string, data: Buffer): Promise<string>;
  getUrl(path: string): string;
  delete(path: string): Promise<void>;
}
```

Implementations:
- `LocalStorageProvider` - saves to `server/uploads/apks/`, serves via Express static
- (Future) `S3StorageProvider` - uploads to S3, returns signed URLs

## API Endpoints

### Upload APK
```
POST /api/apps/upload
Content-Type: multipart/form-data
Body: { file: <apk-file> }
Response: { packageName, appName, versionName, versionCode, fileSize, id, downloadUrl }
```

### List uploaded packages
```
GET /api/apps/packages
Response: { packages: [...] }
```

### Install on devices
```
POST /api/apps/packages/:packageName/install
Body: { deviceIds: ["id1", "id2", ...] }
Response: { commands: [...] }
```

### Delete package
```
DELETE /api/apps/packages/:packageName
```

## Auto-Install Sync Logic

### Triggers

1. **Device enrollment** - Check policy's requiredApps, queue installs
2. **Policy update** - When requiredApps changes, sync all affected devices
3. **Device policy change** - When device moves to new policy, sync apps

### Sync function

```typescript
async function syncRequiredApps(deviceId: string, policyId: string): Promise<void> {
  const policy = await getPolicy(policyId);
  const requiredApps = policy.requiredApps || [];

  for (const packageName of requiredApps) {
    const pkg = await getPackageByName(packageName);
    if (pkg) {
      await queueInstallCommand(deviceId, pkg);
    }
  }
}
```

## Web UI Components

### AppsPage enhancements
- "Upload APK" button in header
- "Uploaded Packages" tab/section
- Each package: name, version, size, date, "Install" button

### UploadApkModal
- Drag-and-drop or file picker
- Shows extracted metadata after parsing
- Confirm to complete upload

### InstallApkModal
- Package info header
- Device multi-select with checkboxes
- Filter by group, status
- "Select All Online" quick action

### PolicyDetailPage update
- "Required Apps" section
- Multi-select from uploaded packages
- Auto-syncs on save

## File Changes

### Server
- `server/src/db/schema.ts` - app_packages table, requiredApps column
- `server/src/services/storageProvider.ts` - New
- `server/src/services/appPackageStore.ts` - New
- `server/src/app.ts` - Upload/install endpoints, static serving
- `server/src/services/policyStore.ts` - requiredApps sync

### Web UI
- `web-ui/src/hooks/useApps.ts` - Package functions
- `web-ui/src/pages/AppsPage.tsx` - Uploaded section
- `web-ui/src/components/apps/UploadApkModal.tsx` - New
- `web-ui/src/components/apps/InstallApkModal.tsx` - New
- `web-ui/src/pages/PolicyDetailPage.tsx` - Required apps section

### Dependencies
- `multer` - File upload handling
- `node-apk-parser` or `adbkit-apkreader` - APK metadata extraction
