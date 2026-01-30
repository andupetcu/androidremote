/**
 * Agent Binary Store — manages agent binary versions for auto-update distribution.
 * Binaries are stored on disk in server/agent-binaries/ with a manifest.json index.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface AgentBinaryInfo {
  os: string;           // "linux" | "windows"
  arch: string;         // "x64" | "arm64" | "armv7l"
  version: string;      // semver e.g. "0.2.0"
  filename: string;     // e.g. "android-remote-agent-linux-x64"
  sha256: string;       // hex-encoded
  size: number;         // bytes
  uploadedAt: string;   // ISO 8601
}

interface Manifest {
  binaries: AgentBinaryInfo[];
}

const BINARIES_DIR = path.join(__dirname, '..', '..', 'agent-binaries');
const MANIFEST_PATH = path.join(BINARIES_DIR, 'manifest.json');

function ensureDir(): void {
  if (!fs.existsSync(BINARIES_DIR)) {
    fs.mkdirSync(BINARIES_DIR, { recursive: true });
  }
}

function loadManifest(): Manifest {
  ensureDir();
  if (!fs.existsSync(MANIFEST_PATH)) {
    return { binaries: [] };
  }
  try {
    const data = fs.readFileSync(MANIFEST_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { binaries: [] };
  }
}

function saveManifest(manifest: Manifest): void {
  ensureDir();
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

/**
 * Get the latest binary info for a given OS and architecture.
 */
export function getLatest(os: string, arch: string): AgentBinaryInfo | null {
  const manifest = loadManifest();
  // Filter matching binaries, sort by version descending
  const matching = manifest.binaries
    .filter((b) => b.os === os && b.arch === arch)
    .sort((a, b) => compareVersions(b.version, a.version));

  return matching.length > 0 ? matching[0] : null;
}

/**
 * Get the file path for a binary.
 */
export function getBinaryPath(info: AgentBinaryInfo): string {
  return path.join(BINARIES_DIR, info.filename);
}

/**
 * Store a new agent binary.
 */
export function addBinary(
  os: string,
  arch: string,
  version: string,
  data: Buffer,
  originalName?: string,
): AgentBinaryInfo {
  ensureDir();

  const ext = os === 'windows' ? '.exe' : '';
  const filename = `android-remote-agent-${os}-${arch}-v${version}${ext}`;
  const filePath = path.join(BINARIES_DIR, filename);

  // Compute SHA-256
  const hash = crypto.createHash('sha256').update(data).digest('hex');

  // Write binary to disk
  fs.writeFileSync(filePath, data);

  const info: AgentBinaryInfo = {
    os,
    arch,
    version,
    filename,
    sha256: hash,
    size: data.length,
    uploadedAt: new Date().toISOString(),
  };

  // Update manifest — remove any existing entry for same os/arch/version
  const manifest = loadManifest();
  manifest.binaries = manifest.binaries.filter(
    (b) => !(b.os === os && b.arch === arch && b.version === version),
  );
  manifest.binaries.push(info);
  saveManifest(manifest);

  return info;
}

/**
 * List all stored binaries.
 */
export function listBinaries(): AgentBinaryInfo[] {
  return loadManifest().binaries;
}

/**
 * Simple semver comparison. Returns negative if a < b, 0 if equal, positive if a > b.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

export const agentBinaryStore = {
  getLatest,
  getBinaryPath,
  addBinary,
  listBinaries,
};
