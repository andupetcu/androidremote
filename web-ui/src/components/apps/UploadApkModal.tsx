import { useState, useRef, useCallback } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import './UploadApkModal.css';

interface UploadApkModalProps {
  open: boolean;
  onClose: () => void;
  onUpload: (file: File, metadata: {
    packageName: string;
    appName?: string;
    versionName?: string;
    versionCode?: number;
  }) => Promise<unknown>;
}

export function UploadApkModal({ open, onClose, onUpload }: UploadApkModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [packageName, setPackageName] = useState('');
  const [appName, setAppName] = useState('');
  const [versionName, setVersionName] = useState('');
  const [versionCode, setVersionCode] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleReset = useCallback(() => {
    setFile(null);
    setPackageName('');
    setAppName('');
    setVersionName('');
    setVersionCode('');
    setError(null);
    setUploading(false);
  }, []);

  const handleClose = useCallback(() => {
    handleReset();
    onClose();
  }, [handleReset, onClose]);

  const handleFileSelect = (selectedFile: File) => {
    if (!selectedFile.name.endsWith('.apk')) {
      setError('Only APK files are allowed');
      return;
    }
    setFile(selectedFile);
    setError(null);

    // Only auto-fill app name from filename (human-readable)
    // Do NOT auto-fill packageName - user must enter the real Android package name
    const nameWithoutExt = selectedFile.name.replace('.apk', '');
    if (!appName) {
      // Humanize the filename for display name
      setAppName(nameWithoutExt.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile) {
      handleFileSelect(droppedFile);
    }
  }, [appName]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || !packageName) return;

    setUploading(true);
    setError(null);

    try {
      await onUpload(file, {
        packageName,
        appName: appName || undefined,
        versionName: versionName || undefined,
        versionCode: versionCode ? parseInt(versionCode, 10) : undefined,
      });
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <Modal open={open} onClose={handleClose} title="Upload APK" size="md">
      <form className="upload-apk-modal" onSubmit={handleSubmit}>
        {/* Drop Zone */}
        <div
          className={`upload-apk-modal__dropzone ${isDragging ? 'upload-apk-modal__dropzone--dragging' : ''} ${file ? 'upload-apk-modal__dropzone--has-file' : ''}`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".apk"
            onChange={(e) => e.target.files?.[0] && handleFileSelect(e.target.files[0])}
            hidden
          />
          {file ? (
            <div className="upload-apk-modal__file-info">
              <span className="upload-apk-modal__file-icon">APK</span>
              <div className="upload-apk-modal__file-details">
                <span className="upload-apk-modal__file-name">{file.name}</span>
                <span className="upload-apk-modal__file-size">{formatFileSize(file.size)}</span>
              </div>
              <button
                type="button"
                className="upload-apk-modal__file-remove"
                onClick={(e) => {
                  e.stopPropagation();
                  setFile(null);
                }}
              >
                Remove
              </button>
            </div>
          ) : (
            <div className="upload-apk-modal__dropzone-content">
              <span className="upload-apk-modal__dropzone-icon">+</span>
              <p>Drag & drop APK file here</p>
              <p className="upload-apk-modal__dropzone-hint">or click to browse</p>
            </div>
          )}
        </div>

        {/* Metadata Fields */}
        <div className="upload-apk-modal__fields">
          <div className="upload-apk-modal__field">
            <label htmlFor="packageName">Package Name *</label>
            <input
              id="packageName"
              type="text"
              value={packageName}
              onChange={(e) => setPackageName(e.target.value)}
              placeholder="com.example.app"
              required
            />
            <span className="upload-apk-modal__hint">
              Android package identifier (e.g., com.company.appname). Find it in the APK's AndroidManifest.xml or use: <code>aapt dump badging app.apk | grep package</code>
            </span>
          </div>

          <div className="upload-apk-modal__field">
            <label htmlFor="appName">App Name</label>
            <input
              id="appName"
              type="text"
              value={appName}
              onChange={(e) => setAppName(e.target.value)}
              placeholder="My Application"
            />
          </div>

          <div className="upload-apk-modal__row">
            <div className="upload-apk-modal__field">
              <label htmlFor="versionName">Version Name</label>
              <input
                id="versionName"
                type="text"
                value={versionName}
                onChange={(e) => setVersionName(e.target.value)}
                placeholder="1.0.0"
              />
            </div>

            <div className="upload-apk-modal__field">
              <label htmlFor="versionCode">Version Code</label>
              <input
                id="versionCode"
                type="number"
                value={versionCode}
                onChange={(e) => setVersionCode(e.target.value)}
                placeholder="1"
                min="1"
              />
            </div>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="upload-apk-modal__error">{error}</div>
        )}

        {/* Actions */}
        <div className="upload-apk-modal__actions">
          <Button type="button" variant="secondary" onClick={handleClose} disabled={uploading}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!file || !packageName || uploading}>
            {uploading ? (
              <>
                <Spinner size="sm" />
                Uploading...
              </>
            ) : (
              'Upload'
            )}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
