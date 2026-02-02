#!/usr/bin/env bash
# ============================================================================
# Build the NSIS Windows installer for Android Remote Agent
#
# Prerequisites:
#   - makensis (brew install makensis on macOS, apt install nsis on Linux)
#   - A compiled Windows agent binary at agent/dist/android-remote-agent-windows-x64.exe
#     (either cross-compiled via cargo or copied from a Windows build)
#
# Usage:
#   ./build-installer.sh              # Build installer from existing binary
#   ./build-installer.sh --cross      # Cross-compile agent first, then build installer
#
# Output:
#   agent/dist/Setup-AndroidRemote.exe
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$AGENT_DIR/dist"
NSI_FILE="$SCRIPT_DIR/windows/installer.nsi"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ── Check prerequisites ────────────────────────────────────────────────────

if ! command -v makensis &>/dev/null; then
    error "makensis not found."
    echo "  macOS:  brew install makensis"
    echo "  Linux:  sudo apt install nsis"
    exit 1
fi

# ── Optional: cross-compile the agent ──────────────────────────────────────

if [[ "${1:-}" == "--cross" ]]; then
    info "Cross-compiling agent for Windows x86_64..."

    if ! rustup target list --installed | grep -q x86_64-pc-windows-gnu; then
        warn "Adding Rust target x86_64-pc-windows-gnu..."
        rustup target add x86_64-pc-windows-gnu
    fi

    cd "$AGENT_DIR"
    cargo build --release --target x86_64-pc-windows-gnu

    # Copy to dist directory
    mkdir -p "$DIST_DIR"
    cp "$AGENT_DIR/target/x86_64-pc-windows-gnu/release/agent-bin.exe" \
       "$DIST_DIR/android-remote-agent-windows-x64.exe"

    info "Agent binary compiled and copied to dist/"
fi

# ── Verify the agent binary exists ─────────────────────────────────────────

AGENT_BINARY="$DIST_DIR/android-remote-agent-windows-x64.exe"

if [[ ! -f "$AGENT_BINARY" ]]; then
    error "Agent binary not found at: $AGENT_BINARY"
    echo "  Either:"
    echo "    1. Build on Windows and copy to agent/dist/"
    echo "    2. Run: $0 --cross  (to cross-compile from macOS/Linux)"
    exit 1
fi

BINARY_SIZE=$(stat -f%z "$AGENT_BINARY" 2>/dev/null || stat -c%s "$AGENT_BINARY" 2>/dev/null)
info "Agent binary: $AGENT_BINARY ($(( BINARY_SIZE / 1024 / 1024 )) MB)"

# ── Build the NSIS installer ──────────────────────────────────────────────

info "Building NSIS installer..."

mkdir -p "$DIST_DIR"

makensis "$NSI_FILE"

INSTALLER="$DIST_DIR/Setup-AndroidRemote.exe"

if [[ -f "$INSTALLER" ]]; then
    INSTALLER_SIZE=$(stat -f%z "$INSTALLER" 2>/dev/null || stat -c%s "$INSTALLER" 2>/dev/null)
    info "Installer built successfully!"
    info "  Output: $INSTALLER"
    info "  Size:   $(( INSTALLER_SIZE / 1024 / 1024 )) MB"
else
    error "Installer build failed — output file not found."
    exit 1
fi
