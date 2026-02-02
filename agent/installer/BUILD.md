# Building the Windows Installer

## Overview

The Windows installer is built using NSIS (Nullsoft Scriptable Install System). The build
can run on macOS, Linux, or Windows. The output is `Setup-AndroidRemote.exe` — a standard
Windows installer wizard with Add/Remove Programs support.

## Prerequisites

### macOS

```bash
brew install makensis
```

### Linux (Debian/Ubuntu)

```bash
sudo apt install nsis
```

### Windows

Download NSIS from https://nsis.sourceforge.io/Download and add it to PATH.

### Rust toolchain (for cross-compilation only)

If building the agent binary from macOS/Linux:

```bash
rustup target add x86_64-pc-windows-gnu
# macOS: brew install mingw-w64
# Linux: sudo apt install gcc-mingw-w64-x86-64
```

## Building

### Quick build (agent binary already compiled)

If you already have `agent/dist/android-remote-agent-windows-x64.exe` (e.g. built on
Windows or in CI):

```bash
cd agent/installer
./build-installer.sh
```

### Full build with cross-compilation

Compiles the agent from source and builds the installer:

```bash
cd agent/installer
./build-installer.sh --cross
```

### Manual NSIS build

```bash
makensis agent/installer/windows/installer.nsi
```

### Output

```
agent/dist/Setup-AndroidRemote.exe
```

## How the installer works

### Installation modes

1. **Pre-configured** (downloaded from admin UI): The server appends a JSON config trailer
   to the exe containing the server URL and enrollment token. The installer reads this
   trailer at startup — no user input needed. Just double-click.

2. **Command-line / silent**: For scripted deployment:
   ```
   Setup-AndroidRemote.exe /S /SERVER_URL=https://your-server:7899 /TOKEN=ABC123
   ```

3. **GUI with parameters**: Same as silent but without `/S` — shows the wizard UI.

### What the installer does

1. Extracts `android-remote-agent.exe` to `C:\Program Files\AndroidRemoteAgent`
2. Runs `android-remote-agent.exe install --server-url ... --enroll-token ... --install-dir ...`
3. The agent binary enrolls with the server, saves config to the install directory,
   registers a Windows service, and starts it
4. Creates an uninstaller at `C:\Program Files\AndroidRemoteAgent\uninstall.exe`
5. Adds a Start Menu entry and Add/Remove Programs registry keys

### Uninstallation

- Via Add/Remove Programs ("Android Remote Agent")
- Or run: `C:\Program Files\AndroidRemoteAgent\uninstall.exe`
- Silent: `uninstall.exe /S`

The uninstaller stops the service, removes it, deletes all files, and cleans up
registry entries.

## Server-side: pre-configured installer downloads

The server provides `GET /api/downloads/installer/windows?token=ABC123` which:

1. Reads the base `Setup-AndroidRemote.exe` from `server/data/installers/windows-x64.exe`
2. Appends a JSON trailer: `{"serverUrl":"...","enrollToken":"ABC123"}`
3. Serves the modified exe

Upload the base installer to the server:

```bash
curl -X POST https://your-server:7899/api/agent/upload-installer \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "platform=windows" \
  -F "file=@agent/dist/Setup-AndroidRemote.exe"
```

After uploading, the "Download Windows Installer" buttons in the admin UI will work.

## Linux agent deployment

Linux does not use an NSIS installer. Deploy with the one-liner:

```bash
curl -fsSL https://your-server:7899/api/downloads/agent/linux -o /tmp/agent \
  && chmod +x /tmp/agent \
  && sudo /tmp/agent install --server-url "https://your-server:7899" --enroll-token "ABC123"
```

The `install` subcommand copies the binary to `/opt/android-remote-agent/`, enrolls
with the server, saves config, creates a systemd service, and starts it.
