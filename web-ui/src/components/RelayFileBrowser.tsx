import { useCallback, useEffect, useRef, useState } from 'react';
import { useRelayWebSocket } from '../hooks/useRelayWebSocket';
import { useAuth } from '../hooks/useAuth';
import * as Protocol from '../lib/BinaryProtocol';

export interface RelayFileBrowserProps {
  deviceId: string;
}

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number | null;
  permissions: string | null;
}

interface DownloadState {
  path: string;
  chunks: Map<number, Uint8Array>;
  total: number;
}

export function RelayFileBrowser({ deviceId }: RelayFileBrowserProps) {
  const { token } = useAuth();
  const [currentPath, setCurrentPath] = useState('/');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const downloadRef = useRef<DownloadState | null>(null);
  const requestIdRef = useRef(1);

  const nextRequestId = () => requestIdRef.current++;

  const onMessage = useCallback((msg: Protocol.ProtocolMessage) => {
    if (msg.header.type === Protocol.FILE_LIST_RESP) {
      try {
        const list = Protocol.parseJsonPayload<FileEntry[]>(msg);
        setEntries(list);
        setLoading(false);
        setError(null);
      } catch {
        setError('Failed to parse directory listing');
        setLoading(false);
      }
    } else if (msg.header.type === Protocol.FILE_DOWNLOAD_DATA) {
      handleDownloadChunk(msg);
    } else if (msg.header.type === Protocol.FILE_RESULT) {
      try {
        const result = Protocol.parseJsonPayload<{ success: boolean; error?: string }>(msg);
        if (!result.success) {
          setError(result.error || 'Operation failed');
        } else {
          setStatusMessage('Operation completed');
          setTimeout(() => setStatusMessage(null), 2000);
        }
      } catch {
        // ignore
      }
    } else if (msg.header.type === Protocol.FILE_UPLOAD_DONE) {
      setStatusMessage('Upload complete');
      setTimeout(() => setStatusMessage(null), 2000);
      // Refresh current directory
      requestListing(currentPath);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath]);

  const { state, connect, disconnect, send, channelId } = useRelayWebSocket({
    deviceId,
    sessionType: 'files',
    token: token || '',
    autoConnect: false,
    onMessage,
  });

  // Auto-connect
  useEffect(() => {
    if (token && state === 'disconnected') {
      connect();
    }
    return () => {
      disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // When connected, the server sends an initial FILE_LIST_REQ for '/'
  // so we should receive a FILE_LIST_RESP automatically.
  // Set loading when we connect.
  useEffect(() => {
    if (state === 'connected') {
      setLoading(true);
      setCurrentPath('/');
    }
  }, [state]);

  const requestListing = useCallback(
    (path: string) => {
      setLoading(true);
      setError(null);
      const ch = channelId ?? 0;
      const msg = Protocol.encodeJson(Protocol.FILE_LIST_REQ, ch, nextRequestId(), { path });
      send(msg);
    },
    [send, channelId]
  );

  const navigateTo = useCallback(
    (path: string) => {
      setCurrentPath(path);
      requestListing(path);
    },
    [requestListing]
  );

  const navigateUp = useCallback(() => {
    if (currentPath === '/') return;
    const parts = currentPath.replace(/\/$/, '').split('/');
    parts.pop();
    const parent = parts.join('/') || '/';
    navigateTo(parent);
  }, [currentPath, navigateTo]);

  const handleDownloadChunk = useCallback((msg: Protocol.ProtocolMessage) => {
    if (msg.payload.length < 8) return;

    const view = new DataView(
      msg.payload.buffer,
      msg.payload.byteOffset,
      msg.payload.byteLength
    );
    const seq = view.getUint32(0, true);
    const total = view.getUint32(4, true);
    const data = msg.payload.slice(8);

    const dl = downloadRef.current;
    if (!dl) return;

    dl.chunks.set(seq, data);
    dl.total = total;

    // Check if all chunks received
    if (dl.chunks.size >= total) {
      // Reassemble
      const parts: Uint8Array[] = [];
      for (let i = 0; i < total; i++) {
        const chunk = dl.chunks.get(i);
        if (chunk) parts.push(chunk);
      }
      const blob = new Blob(parts);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = dl.path.split('/').pop() || 'download';
      a.click();
      URL.revokeObjectURL(url);
      downloadRef.current = null;
      setStatusMessage('Download complete');
      setTimeout(() => setStatusMessage(null), 2000);
    }
  }, []);

  const requestDownload = useCallback(
    (path: string) => {
      downloadRef.current = { path, chunks: new Map(), total: 0 };
      const ch = channelId ?? 0;
      const msg = Protocol.encodeJson(Protocol.FILE_DOWNLOAD_REQ, ch, nextRequestId(), { path });
      send(msg);
      setStatusMessage(`Downloading ${path.split('/').pop()}...`);
    },
    [send, channelId]
  );

  const requestDelete = useCallback(
    (path: string) => {
      const name = path.split('/').pop() || path;
      if (!window.confirm(`Delete "${name}"?`)) return;

      const ch = channelId ?? 0;
      const msg = Protocol.encodeJson(Protocol.FILE_DELETE_REQ, ch, nextRequestId(), { path });
      send(msg);
      setStatusMessage(`Deleting ${name}...`);
      // Refresh after a brief delay
      setTimeout(() => requestListing(currentPath), 500);
    },
    [send, channelId, currentPath, requestListing]
  );

  const handleUpload = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;

      const data = await file.arrayBuffer();
      const bytes = new Uint8Array(data);
      const uploadPath = currentPath === '/'
        ? `/${file.name}`
        : `${currentPath.replace(/\/$/, '')}/${file.name}`;

      const ch = channelId ?? 0;
      const reqId = nextRequestId();

      // Send FILE_UPLOAD_START
      const startMsg = Protocol.encodeJson(Protocol.FILE_UPLOAD_START, ch, reqId, {
        path: uploadPath,
        size: bytes.length,
      });
      send(startMsg);

      // Send FILE_UPLOAD_DATA (raw bytes with seq header)
      const chunkSize = 64 * 1024;
      const totalChunks = Math.max(1, Math.ceil(bytes.length / chunkSize));
      for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, bytes.length);
        const chunk = bytes.slice(start, end);

        const payload = new Uint8Array(4 + chunk.length);
        const pview = new DataView(payload.buffer);
        pview.setUint32(0, i, true); // seq
        payload.set(chunk, 4);

        const dataMsg = Protocol.encode(Protocol.FILE_UPLOAD_DATA, ch, reqId, payload);
        send(dataMsg);
      }

      setStatusMessage(`Uploading ${file.name}...`);
    };
    input.click();
  }, [send, channelId, currentPath]);

  const formatSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
  };

  const formatDate = (timestamp: number | null): string => {
    if (!timestamp) return '-';
    return new Date(timestamp * 1000).toLocaleString();
  };

  if (state !== 'connected' && state !== 'connecting') {
    return (
      <div className="file-browser">
        <div className="file-browser__empty">
          <p>File browser requires an active connection.</p>
          <button className="file-browser__btn file-browser__btn--primary" onClick={connect}>
            Connect
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="file-browser">
      {/* Toolbar */}
      <div className="file-browser__toolbar">
        <div className="file-browser__nav">
          <button
            className="file-browser__btn"
            onClick={navigateUp}
            disabled={currentPath === '/'}
            title="Go up"
          >
            ..
          </button>
          <span className="file-browser__path">{currentPath}</span>
          <button
            className="file-browser__btn"
            onClick={() => requestListing(currentPath)}
            title="Refresh"
          >
            Refresh
          </button>
        </div>
        <div className="file-browser__actions">
          <button className="file-browser__btn file-browser__btn--primary" onClick={handleUpload}>
            Upload
          </button>
        </div>
      </div>

      {/* Status messages */}
      {statusMessage && (
        <div className="file-browser__status">{statusMessage}</div>
      )}
      {error && (
        <div className="file-browser__error">{error}</div>
      )}

      {/* File list */}
      <div className="file-browser__list">
        {loading && (
          <div className="file-browser__loading">
            <div className="spinner" />
            <span>Loading...</span>
          </div>
        )}
        {!loading && entries.length === 0 && (
          <div className="file-browser__empty-dir">
            <p>Empty directory</p>
          </div>
        )}
        {!loading && entries.length > 0 && (
          <table className="file-browser__table">
            <thead>
              <tr>
                <th className="file-browser__th">Name</th>
                <th className="file-browser__th file-browser__th--size">Size</th>
                <th className="file-browser__th file-browser__th--date">Modified</th>
                <th className="file-browser__th file-browser__th--perms">Perms</th>
                <th className="file-browser__th file-browser__th--actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.path} className="file-browser__row">
                  <td className="file-browser__td file-browser__td--name">
                    {entry.is_dir ? (
                      <button
                        className="file-browser__link"
                        onClick={() => navigateTo(entry.path)}
                      >
                        {entry.name}/
                      </button>
                    ) : (
                      <span>{entry.name}</span>
                    )}
                  </td>
                  <td className="file-browser__td file-browser__td--size">
                    {entry.is_dir ? '-' : formatSize(entry.size)}
                  </td>
                  <td className="file-browser__td file-browser__td--date">
                    {formatDate(entry.modified)}
                  </td>
                  <td className="file-browser__td file-browser__td--perms">
                    {entry.permissions || '-'}
                  </td>
                  <td className="file-browser__td file-browser__td--actions">
                    {!entry.is_dir && (
                      <button
                        className="file-browser__btn file-browser__btn--small"
                        onClick={() => requestDownload(entry.path)}
                      >
                        Download
                      </button>
                    )}
                    <button
                      className="file-browser__btn file-browser__btn--small file-browser__btn--danger"
                      onClick={() => requestDelete(entry.path)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
