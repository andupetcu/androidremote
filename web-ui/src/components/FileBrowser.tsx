import { useState, useEffect, useCallback, type ReactElement } from 'react';
import { apiFetch } from '../utils/api';

export interface FileItem {
  name: string;
  type: 'file' | 'directory';
  size?: number;
}

export interface FileBrowserProps {
  onFileSelect?: (file: FileItem) => void;
}

type BrowserState =
  | { status: 'loading' }
  | { status: 'loaded'; files: FileItem[] }
  | { status: 'error'; message: string }
  | { status: 'uploading' };

export function FileBrowser({ onFileSelect }: FileBrowserProps): ReactElement {
  const [state, setState] = useState<BrowserState>({ status: 'loading' });
  const [currentPath, setCurrentPath] = useState('/');
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const fetchFiles = useCallback(async (path: string) => {
    setState({ status: 'loading' });
    try {
      const response = await apiFetch(`/api/files?path=${encodeURIComponent(path)}`);
      if (!response.ok) {
        throw new Error('Failed to load files');
      }
      const data = await response.json();
      setState({ status: 'loaded', files: data.files });
    } catch {
      setState({ status: 'error', message: 'Failed to load files' });
    }
  }, []);

  useEffect(() => {
    fetchFiles(currentPath);
  }, [currentPath, fetchFiles]);

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handleItemClick = (file: FileItem, event: React.MouseEvent) => {
    if (file.type === 'directory') {
      // Navigate into directory
      setCurrentPath(currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`);
      setSelectedFiles(new Set());
    } else {
      // Select file
      if (event.ctrlKey || event.metaKey) {
        // Multi-select
        const newSelection = new Set(selectedFiles);
        if (newSelection.has(file.name)) {
          newSelection.delete(file.name);
        } else {
          newSelection.add(file.name);
        }
        setSelectedFiles(newSelection);
      } else {
        // Single select
        setSelectedFiles(new Set([file.name]));
      }
      onFileSelect?.(file);
    }
  };

  const handleBack = () => {
    if (currentPath === '/') return;
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    setCurrentPath(parts.length === 0 ? '/' : '/' + parts.join('/'));
    setSelectedFiles(new Set());
  };

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    setState({ status: 'uploading' });
    setMessage('Uploading...');

    try {
      const formData = new FormData();
      formData.append('file', files[0]);
      formData.append('path', currentPath);

      const response = await fetch('/api/files/upload', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error('Upload failed');
      }

      setMessage('Uploaded successfully');
      fetchFiles(currentPath);
    } catch {
      setMessage('Upload failed');
      // Restore loaded state
      fetchFiles(currentPath);
    }

    // Clear message after delay
    setTimeout(() => setMessage(null), 3000);
  };

  const handleDownload = async () => {
    if (selectedFiles.size === 0) return;

    const fileName = Array.from(selectedFiles)[0];
    try {
      const response = await apiFetch(`/api/files/download/${encodeURIComponent(fileName)}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      URL.revokeObjectURL(url);
    } catch {
      setMessage('Download failed');
    }
  };

  const handleDelete = () => {
    setShowDeleteConfirm(true);
  };

  const handleRefresh = () => {
    fetchFiles(currentPath);
  };

  if (state.status === 'loading') {
    return <div>Loading...</div>;
  }

  if (state.status === 'uploading') {
    return <div>Uploading...</div>;
  }

  if (state.status === 'error') {
    return <div>{state.message}</div>;
  }

  return (
    <div>
      {/* Toolbar */}
      <div style={{ marginBottom: '1rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <button onClick={handleBack} aria-label="Back" disabled={currentPath === '/'}>
          Back
        </button>
        <span>{currentPath}</span>
        <button onClick={handleRefresh} aria-label="Refresh">
          Refresh
        </button>
        <label>
          <span style={{ display: 'none' }}>Upload</span>
          <input
            type="file"
            onChange={handleUpload}
            aria-label="Upload"
            style={{ marginLeft: '0.5rem' }}
          />
        </label>
        <button
          onClick={handleDownload}
          aria-label="Download"
          disabled={selectedFiles.size === 0}
        >
          Download
        </button>
        <button
          onClick={handleDelete}
          aria-label="Delete"
          disabled={selectedFiles.size === 0}
        >
          Delete
        </button>
      </div>

      {/* Messages */}
      {message && <div>{message}</div>}

      {/* Delete Confirmation */}
      {showDeleteConfirm && (
        <div>
          <p>Are you sure you want to delete the selected files?</p>
          <button onClick={() => setShowDeleteConfirm(false)}>Cancel</button>
          <button onClick={() => {
            setShowDeleteConfirm(false);
            // Delete logic would go here
          }}>
            Confirm
          </button>
        </div>
      )}

      {/* File List */}
      <div>
        {state.files.map((file) => (
          <div
            key={file.name}
            data-testid="file-item"
            data-type={file.type}
            className={selectedFiles.has(file.name) ? 'selected' : ''}
            onClick={(e) => handleItemClick(file, e)}
            style={{
              padding: '0.5rem',
              cursor: 'pointer',
              backgroundColor: selectedFiles.has(file.name) ? '#e3f2fd' : 'transparent',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            }}
          >
            <span>{file.type === 'directory' ? '📁' : '📄'}</span>
            <span>{file.name}</span>
            {file.type === 'file' && file.size !== undefined && (
              <span style={{ marginLeft: 'auto', color: '#666' }}>
                {formatSize(file.size)}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
