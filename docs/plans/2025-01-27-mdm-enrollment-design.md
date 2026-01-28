# MDM Enrollment & Silent Control Design

> **Date**: 2025-01-27
> **Status**: Approved

## Overview

This design adds MDM-style device enrollment, command queue system, silent package installation, and two-tier input injection (ADB Shell + Root Daemon) for screen control.

## Goals

1. Admin-controlled device enrollment via tokens
2. Command queue for remote device management
3. Silent APK installation (Device Owner mode)
4. True silent remote control (no user prompts) via ADB/Root

---

## 1. Enrollment Token System

### Server Endpoints

```
POST   /api/enroll/tokens          # Admin creates enrollment token
GET    /api/enroll/tokens          # List active tokens
DELETE /api/enroll/tokens/:id      # Revoke a token
POST   /api/enroll/device          # Device submits token to enroll
```

### Data Model

```typescript
interface EnrollmentToken {
  id: string;              // token-xxxx (for management)
  token: string;           // 8-char alphanumeric (user enters this)
  createdAt: number;
  expiresAt: number;       // 24 hours default
  maxUses: number;         // 1 = single device, or N for bulk
  usedCount: number;
  status: 'active' | 'exhausted' | 'revoked' | 'expired';
}
```

### Database Schema

```sql
CREATE TABLE enrollment_tokens (
  id TEXT PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  max_uses INTEGER DEFAULT 1,
  used_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'exhausted', 'revoked', 'expired'))
);

CREATE INDEX idx_enrollment_tokens_token ON enrollment_tokens(token);
```

### Enrollment Flow

1. Admin calls `POST /api/enroll/tokens` → receives `{ id, token: "ABC12345" }`
2. Admin gives token to user (verbally, email, etc.)
3. User opens Android app → enters token
4. App calls `POST /api/enroll/device` with token + device info
5. Server validates token, enrolls device, returns `{ deviceId, serverUrl }`
6. Device is now managed

---

## 2. Command Queue System

### Server Endpoints

```
POST   /api/devices/:id/commands           # Admin queues a command
GET    /api/devices/:id/commands/pending   # Device polls for pending commands
PATCH  /api/devices/:id/commands/:cmdId    # Device acknowledges completion
```

### Data Model

```typescript
interface DeviceCommand {
  id: string;
  deviceId: string;
  type: 'INSTALL_APK' | 'UNINSTALL_APP' | 'LOCK' | 'REBOOT' | 'WIPE' | 'START_REMOTE';
  payload: Record<string, unknown>;
  status: 'pending' | 'delivered' | 'executing' | 'completed' | 'failed';
  createdAt: number;
  deliveredAt?: number;
  completedAt?: number;
  error?: string;
}
```

### Command Payloads

| Command | Payload |
|---------|---------|
| `INSTALL_APK` | `{ url: string, packageName: string }` |
| `UNINSTALL_APP` | `{ packageName: string }` |
| `LOCK` | `{}` |
| `REBOOT` | `{}` |
| `WIPE` | `{ keepData?: boolean }` |
| `START_REMOTE` | `{ signalingUrl: string }` |

### Database Schema

```sql
CREATE TABLE device_commands (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,  -- JSON
  status TEXT DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  completed_at INTEGER,
  error TEXT,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

CREATE INDEX idx_device_commands_device ON device_commands(device_id);
CREATE INDEX idx_device_commands_status ON device_commands(device_id, status);
```

---

## 3. Silent Package Installer (Android)

### Class: `SilentPackageInstaller`

```kotlin
class SilentPackageInstaller(private val context: Context) {

    suspend fun installFromUrl(url: String, packageName: String): Result<InstallResult>
    suspend fun installFromFile(file: File, packageName: String): Result<InstallResult>
    suspend fun uninstall(packageName: String): Result<Unit>
}

sealed class InstallResult {
    object Success : InstallResult()
    data class Failure(val code: Int, val message: String) : InstallResult()
}
```

### Installation Flow

1. Download APK to `context.cacheDir`
2. Verify Device Owner status via `DeviceOwnerManager`
3. Create `PackageInstaller.Session` with `MODE_FULL_INSTALL`
4. Write APK bytes to session
5. Commit with `PendingIntent` to `InstallResultReceiver`
6. Broadcast receiver captures result
7. Clean up cached APK
8. Return `Success` or `Failure`

### Fallback Behavior

If not Device Owner, fall back to standard install intent (user must approve).

---

## 4. Input Injection Architecture

### Interface

```kotlin
interface InputInjector {
    suspend fun tap(x: Int, y: Int): Result<Unit>
    suspend fun swipe(startX: Int, startY: Int, endX: Int, endY: Int, durationMs: Long): Result<Unit>
    suspend fun longPress(x: Int, y: Int, durationMs: Long): Result<Unit>
    suspend fun keyEvent(keyCode: Int): Result<Unit>
    suspend fun text(input: String): Result<Unit>
    fun isAvailable(): Boolean
}
```

### Implementation 1: ADB Shell Injector (Quick, for testing)

```kotlin
class AdbShellInjector : InputInjector {
    // Uses Runtime.exec() to run shell commands
    // Requires: app runs as shell user OR device has root

    override suspend fun tap(x: Int, y: Int) = runShell("input tap $x $y")
    override suspend fun swipe(...) = runShell("input swipe $startX $startY $endX $endY $durationMs")
    override suspend fun keyEvent(keyCode: Int) = runShell("input keyevent $keyCode")
    override suspend fun text(input: String) = runShell("input text '${input.escape()}'")

    private suspend fun runShell(cmd: String): Result<Unit> = withContext(Dispatchers.IO) {
        val process = Runtime.getRuntime().exec(arrayOf("sh", "-c", cmd))
        val exitCode = process.waitFor()
        if (exitCode == 0) Result.success(Unit)
        else Result.failure(ShellException(exitCode))
    }
}
```

**Characteristics:**
- ~100-200ms per command (process spawn overhead)
- Works on rooted devices or ADB shell
- No additional binaries needed
- Good for development/testing

### Implementation 2: Root Daemon Injector (Production)

```kotlin
class RootDaemonInjector(private val socketPath: String = "/data/local/tmp/android-remote.sock") : InputInjector {
    // Communicates with Rust daemon via Unix socket
    // Daemon uses /dev/uinput for direct input injection

    private var socket: LocalSocket? = null

    override suspend fun tap(x: Int, y: Int) = sendCommand(TapCommand(x, y))
    override suspend fun swipe(...) = sendCommand(SwipeCommand(...))

    private suspend fun sendCommand(cmd: DaemonCommand): Result<Unit>
}
```

**Characteristics:**
- <10ms per command (no process spawn)
- Requires root daemon binary installed
- Production-grade performance
- Supports complex multi-touch gestures

### Injector Selection

```kotlin
object InputInjectorFactory {
    fun create(context: Context): InputInjector {
        return when {
            RootDaemonInjector().isAvailable() -> RootDaemonInjector()
            AdbShellInjector().isAvailable() -> AdbShellInjector()
            else -> AccessibilityInjector(context)  // Fallback
        }
    }
}
```

---

## 5. Screen Capture Architecture

### Interface

```kotlin
interface ScreenCapturer {
    suspend fun captureFrame(): Result<Bitmap>
    fun startStream(fps: Int, onFrame: (Bitmap) -> Unit): Job
    fun stopStream()
    fun isAvailable(): Boolean
}
```

### Implementation 1: ADB Screen Capturer (Quick, for testing)

```kotlin
class AdbScreenCapturer : ScreenCapturer {
    override suspend fun captureFrame(): Result<Bitmap> = withContext(Dispatchers.IO) {
        val process = Runtime.getRuntime().exec("screencap -p")
        val bitmap = BitmapFactory.decodeStream(process.inputStream)
        Result.success(bitmap)
    }
}
```

**Characteristics:**
- ~300-500ms per frame
- Good for testing, not real-time
- No user consent needed (with root/shell)

### Implementation 2: Root Screen Capturer (Production)

```kotlin
class RootScreenCapturer(private val daemonSocket: String) : ScreenCapturer {
    // Daemon captures via SurfaceFlinger or /dev/graphics/fb0
    // Streams H.264 encoded frames

    override fun startStream(fps: Int, onFrame: (Bitmap) -> Unit): Job {
        // Connect to daemon, receive encoded frames
    }
}
```

**Characteristics:**
- 30+ fps possible
- Hardware encoding support
- Production-grade streaming

---

## 6. Android Command Handler Service

### Service: `CommandPollingService`

```kotlin
class CommandPollingService : Service() {
    private val pollInterval = 30_000L  // 30 seconds

    override fun onStartCommand(...) {
        startPolling()
        return START_STICKY
    }

    private fun startPolling() {
        scope.launch {
            while (isActive) {
                fetchAndExecuteCommands()
                delay(pollInterval)
            }
        }
    }

    private suspend fun fetchAndExecuteCommands() {
        val commands = api.getPendingCommands(deviceId)
        commands.forEach { cmd ->
            val result = executeCommand(cmd)
            api.acknowledgeCommand(cmd.id, result)
        }
    }

    private suspend fun executeCommand(cmd: DeviceCommand): CommandResult {
        return when (cmd.type) {
            "INSTALL_APK" -> silentInstaller.installFromUrl(cmd.payload.url, cmd.payload.packageName)
            "UNINSTALL_APP" -> silentInstaller.uninstall(cmd.payload.packageName)
            "LOCK" -> deviceOwnerManager.lockDevice()
            "REBOOT" -> deviceOwnerManager.rebootDevice()
            "WIPE" -> deviceOwnerManager.wipeDevice()
            "START_REMOTE" -> startRemoteSession(cmd.payload.signalingUrl)
        }
    }
}
```

---

## 7. File Structure

### Server (New Files)

```
server/src/
├── services/
│   ├── enrollmentStore.ts      # Enrollment token management
│   └── commandStore.ts         # Command queue management
├── db/
│   └── schema.ts               # Add new tables
└── app.ts                      # Add new endpoints
```

### Android (New Files)

```
app/src/main/kotlin/com/androidremote/app/
├── mdm/
│   ├── SilentPackageInstaller.kt
│   ├── InstallResultReceiver.kt
│   └── CommandPollingService.kt
├── input/
│   ├── InputInjector.kt           # Interface
│   ├── AdbShellInjector.kt        # ADB implementation
│   ├── RootDaemonInjector.kt      # Root daemon implementation
│   └── InputInjectorFactory.kt    # Factory
├── capture/
│   ├── ScreenCapturer.kt          # Interface
│   ├── AdbScreenCapturer.kt       # ADB implementation
│   └── RootScreenCapturer.kt      # Root daemon implementation
└── ui/
    └── EnrollmentActivity.kt      # Token entry UI
```

### Root Daemon (Rust - Later Phase)

```
root-daemon/
├── Cargo.toml
├── src/
│   ├── main.rs
│   ├── input.rs          # /dev/uinput handling
│   ├── capture.rs        # Screen capture
│   ├── socket.rs         # Unix socket server
│   └── protocol.rs       # Command protocol
└── build.sh              # Cross-compile for ARM
```

---

## 8. Implementation Order

### Phase A: Server Enrollment & Commands (Day 1)
1. Add database schema for tokens and commands
2. Implement `enrollmentStore.ts`
3. Implement `commandStore.ts`
4. Add REST endpoints to `app.ts`
5. Write tests

### Phase B: Android Enrollment UI (Day 1-2)
1. Create `EnrollmentActivity` with token input
2. Connect to enrollment API
3. Store enrolled state

### Phase C: Silent Package Installer (Day 2)
1. Implement `SilentPackageInstaller`
2. Implement `InstallResultReceiver`
3. Test with Device Owner mode

### Phase D: ADB Shell Injector (Day 2-3)
1. Implement `InputInjector` interface
2. Implement `AdbShellInjector`
3. Implement `AdbScreenCapturer`
4. Integrate with existing remote session

### Phase E: Command Polling Service (Day 3)
1. Implement `CommandPollingService`
2. Wire up all command handlers
3. Test full MDM flow

### Phase F: Root Daemon (Future)
1. Set up Rust project
2. Implement uinput injection
3. Implement screen capture
4. Cross-compile for ARM
5. Create `RootDaemonInjector` Android client

---

## 9. Security Considerations

- Enrollment tokens expire after 24 hours
- Tokens can be single-use or limited-use
- Commands require valid session token
- ADB shell requires rooted device or shell UID
- Root daemon validates caller UID
- All server communication over HTTPS
