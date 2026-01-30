#!/bin/bash
# Android Remote Agent — Linux Installer
# Usage: curl -s https://server/install.sh | bash -s -- --server https://server:7899 --token ABC123
#
# Options:
#   --server URL       Server URL (required)
#   --token TOKEN      Enrollment token (required)
#   --install-dir DIR  Installation directory (default: /opt/android-remote-agent)
#   --user USER        Service user (default: android-remote-agent)
#   --no-service       Don't create systemd service

set -euo pipefail

# Defaults
INSTALL_DIR="/opt/android-remote-agent"
SERVICE_USER="android-remote-agent"
SERVICE_NAME="android-remote-agent"
CREATE_SERVICE=true
SERVER_URL=""
ENROLL_TOKEN=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --server)
      SERVER_URL="$2"
      shift 2
      ;;
    --token)
      ENROLL_TOKEN="$2"
      shift 2
      ;;
    --install-dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    --user)
      SERVICE_USER="$2"
      shift 2
      ;;
    --no-service)
      CREATE_SERVICE=false
      shift
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

if [ -z "$SERVER_URL" ]; then
  echo "Error: --server is required"
  exit 1
fi

if [ -z "$ENROLL_TOKEN" ]; then
  echo "Error: --token is required"
  exit 1
fi

# Detect architecture
detect_arch() {
  local arch
  arch=$(uname -m)
  case "$arch" in
    x86_64)   echo "x64" ;;
    aarch64)  echo "arm64" ;;
    armv7l)   echo "armv7l" ;;
    *)
      echo "Unsupported architecture: $arch" >&2
      exit 1
      ;;
  esac
}

ARCH=$(detect_arch)
OS="linux"

echo "=== Android Remote Agent Installer ==="
echo "Server:  $SERVER_URL"
echo "Arch:    $ARCH"
echo "Install: $INSTALL_DIR"
echo ""

# Convert ws(s) URL to http(s) for API calls
API_BASE=$(echo "$SERVER_URL" | sed 's|^wss://|https://|; s|^ws://|http://|')

# Check for update endpoint to get download URL
echo "Checking for agent binary..."
LATEST=$(curl -sf "${API_BASE}/api/agent/latest?os=${OS}&arch=${ARCH}" 2>/dev/null || true)

if [ -z "$LATEST" ]; then
  echo "Error: No agent binary available for ${OS}/${ARCH}"
  echo "Upload one first via POST /api/agent/upload"
  exit 1
fi

DOWNLOAD_URL=$(echo "$LATEST" | grep -o '"url":"[^"]*"' | cut -d'"' -f4)
VERSION=$(echo "$LATEST" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
SHA256=$(echo "$LATEST" | grep -o '"sha256":"[^"]*"' | cut -d'"' -f4)

echo "Downloading agent v${VERSION}..."

# Create install directory
mkdir -p "$INSTALL_DIR"

# Download binary
TEMP_FILE=$(mktemp)
curl -sf "$DOWNLOAD_URL" -o "$TEMP_FILE"

# Verify checksum
ACTUAL_SHA256=$(sha256sum "$TEMP_FILE" | cut -d' ' -f1)
if [ "$ACTUAL_SHA256" != "$SHA256" ]; then
  echo "Error: Checksum mismatch!"
  echo "  Expected: $SHA256"
  echo "  Got:      $ACTUAL_SHA256"
  rm -f "$TEMP_FILE"
  exit 1
fi

echo "Checksum verified."

# Install binary
BINARY_PATH="${INSTALL_DIR}/android-remote-agent"
mv "$TEMP_FILE" "$BINARY_PATH"
chmod 755 "$BINARY_PATH"

echo "Installed to $BINARY_PATH"

# Create system user if it doesn't exist
if [ "$CREATE_SERVICE" = true ]; then
  if ! id "$SERVICE_USER" &>/dev/null; then
    echo "Creating system user: $SERVICE_USER"
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER" || true
  fi

  # Set ownership
  chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
fi

# Enroll the agent
echo "Enrolling agent..."
"$BINARY_PATH" --server-url "$SERVER_URL" --enroll-token "$ENROLL_TOKEN" --foreground &
AGENT_PID=$!

# Wait a few seconds for enrollment to complete
sleep 5
kill "$AGENT_PID" 2>/dev/null || true
wait "$AGENT_PID" 2>/dev/null || true

echo "Enrollment complete."

# Create systemd service
if [ "$CREATE_SERVICE" = true ]; then
  echo "Creating systemd service..."

  cat > /etc/systemd/system/${SERVICE_NAME}.service << EOF
[Unit]
Description=Android Remote Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
ExecStart=${BINARY_PATH} --server-url ${SERVER_URL}
Restart=always
RestartSec=10
Environment=AGENT_LOG_LEVEL=info

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${INSTALL_DIR}
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  systemctl start "$SERVICE_NAME"

  echo "Service started: $SERVICE_NAME"
  systemctl status "$SERVICE_NAME" --no-pager || true
fi

echo ""
echo "=== Installation Complete ==="
echo "Binary:  $BINARY_PATH"
echo "Version: $VERSION"
if [ "$CREATE_SERVICE" = true ]; then
  echo "Service: $SERVICE_NAME (systemd)"
  echo ""
  echo "Manage with:"
  echo "  systemctl status $SERVICE_NAME"
  echo "  systemctl restart $SERVICE_NAME"
  echo "  journalctl -u $SERVICE_NAME -f"
fi
