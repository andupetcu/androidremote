# Android Remote Control - Implementation Plan

> **NON-NEGOTIABLE:** Tests are written FIRST for every module. No implementation without tests.

## Technology Stack (Confirmed)

| Component | Technology |
|-----------|------------|
| Android App | Kotlin, minSdk 33 (Android 13), targetSdk 35 |
| Testing | JUnit5 + MockK + Espresso |
| Server | Node.js + TypeScript |
| WebRTC | libwebrtc (Google's native) |
| Root Daemon | Rust (cross-compiled) |
| Security | Ed25519 + HMAC + JWT (high paranoia) |
| Distribution | Sideload now → Enterprise/MDM later |

---

## Project Structure

```
android-remote/
├── android/
│   ├── app/                          # Main Android application
│   │   ├── src/main/
│   │   ├── src/test/                 # Unit tests (JVM)
│   │   └── src/androidTest/          # Instrumented tests
│   ├── core-crypto/                  # Pure Kotlin crypto module
│   │   ├── src/main/
│   │   └── src/test/
│   ├── core-protocol/                # Protocol definitions & state machines
│   │   ├── src/main/
│   │   └── src/test/
│   ├── core-transport/               # WebSocket + WebRTC abstractions
│   │   ├── src/main/
│   │   └── src/test/
│   ├── feature-screen/               # Screen capture module
│   ├── feature-input/                # Touch/gesture injection
│   ├── feature-files/                # SAF file transfer
│   ├── feature-camera/               # Camera streaming
│   └── root-daemon/                  # Rust daemon (separate build)
├── server/                           # Node.js signaling/relay server
│   ├── src/
│   ├── test/
│   └── package.json
├── web-ui/                           # Browser dashboard
│   ├── src/
│   ├── test/
│   └── package.json
└── shared/                           # Shared protocol definitions (protobuf/JSON schema)
    └── proto/
```

---

## Phase 0: Project Setup & Test Infrastructure

### 0.1 Android Project Skeleton

**Tests First:**
```kotlin
// core-crypto/src/test/kotlin/CryptoModuleTest.kt
class CryptoModuleTest {
    @Test
    fun `module initializes without errors`() {
        // Verify Gradle module structure is correct
        assertDoesNotThrow { CryptoModule.initialize() }
    }
}
```

**Tasks:**
- [ ] Initialize Android project with Gradle Kotlin DSL
- [ ] Configure multi-module build (core-*, feature-*)
- [ ] Set up JUnit5 with `useJUnitPlatform()`
- [ ] Configure MockK dependency
- [ ] Set up Espresso for instrumented tests
- [ ] Configure code coverage (Jacoco)
- [ ] Set up lint rules and ktlint

**Deliverable:** Green build with empty test suites passing.

### 0.2 Server Project Skeleton

**Tests First:**
```typescript
// server/test/health.test.ts
describe('Server Health', () => {
  it('responds to health check', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
  });
});
```

**Tasks:**
- [ ] Initialize Node.js project with TypeScript
- [ ] Configure Jest for testing
- [ ] Set up Express/Fastify skeleton
- [ ] Configure ESLint + Prettier

### 0.3 Shared Protocol Definitions

**Tasks:**
- [ ] Define message schema (protobuf or JSON Schema)
- [ ] Generate Kotlin data classes
- [ ] Generate TypeScript types
- [ ] Write schema validation tests

---

## Phase 1: Security & Pairing (Tests First)

### 1.1 Crypto Module (`core-crypto`)

**Tests First - Key Generation:**
```kotlin
class KeyGenerationTest {
    @Test
    fun `generates valid Ed25519 key pair`() {
        val keyPair = CryptoService.generateKeyPair()

        assertThat(keyPair.publicKey).hasSize(32)
        assertThat(keyPair.privateKey).hasSize(64)
    }

    @Test
    fun `key pairs are unique`() {
        val keyPair1 = CryptoService.generateKeyPair()
        val keyPair2 = CryptoService.generateKeyPair()

        assertThat(keyPair1.publicKey).isNotEqualTo(keyPair2.publicKey)
    }

    @Test
    fun `derives session key from shared secret`() {
        val deviceKeys = CryptoService.generateKeyPair()
        val controllerKeys = CryptoService.generateKeyPair()

        val sessionKey1 = CryptoService.deriveSessionKey(
            deviceKeys.privateKey,
            controllerKeys.publicKey
        )
        val sessionKey2 = CryptoService.deriveSessionKey(
            controllerKeys.privateKey,
            deviceKeys.publicKey
        )

        assertThat(sessionKey1).isEqualTo(sessionKey2)
    }
}
```

**Tests First - Signing:**
```kotlin
class SigningTest {
    @Test
    fun `signs and verifies message`() {
        val keyPair = CryptoService.generateKeyPair()
        val message = "test message".toByteArray()

        val signature = CryptoService.sign(message, keyPair.privateKey)
        val isValid = CryptoService.verify(message, signature, keyPair.publicKey)

        assertThat(isValid).isTrue()
    }

    @Test
    fun `rejects tampered message`() {
        val keyPair = CryptoService.generateKeyPair()
        val message = "test message".toByteArray()
        val tamperedMessage = "tampered message".toByteArray()

        val signature = CryptoService.sign(message, keyPair.privateKey)
        val isValid = CryptoService.verify(tamperedMessage, signature, keyPair.publicKey)

        assertThat(isValid).isFalse()
    }

    @Test
    fun `rejects wrong public key`() {
        val keyPair1 = CryptoService.generateKeyPair()
        val keyPair2 = CryptoService.generateKeyPair()
        val message = "test message".toByteArray()

        val signature = CryptoService.sign(message, keyPair1.privateKey)
        val isValid = CryptoService.verify(message, signature, keyPair2.publicKey)

        assertThat(isValid).isFalse()
    }
}
```

**Tests First - HMAC for Commands:**
```kotlin
class CommandSigningTest {
    @Test
    fun `signs command with session key`() {
        val sessionKey = CryptoService.generateSessionKey()
        val command = Command(type = "TAP", payload = mapOf("x" to 0.5, "y" to 0.5))

        val signedCommand = CommandSigner.sign(command, sessionKey)

        assertThat(signedCommand.hmac).isNotEmpty()
        assertThat(signedCommand.timestamp).isCloseTo(System.currentTimeMillis(), within(1000))
    }

    @Test
    fun `verifies valid signed command`() {
        val sessionKey = CryptoService.generateSessionKey()
        val command = Command(type = "TAP", payload = mapOf("x" to 0.5, "y" to 0.5))

        val signedCommand = CommandSigner.sign(command, sessionKey)
        val isValid = CommandSigner.verify(signedCommand, sessionKey)

        assertThat(isValid).isTrue()
    }

    @Test
    fun `rejects replay attack - old timestamp`() {
        val sessionKey = CryptoService.generateSessionKey()
        val oldCommand = SignedCommand(
            command = Command(type = "TAP", payload = emptyMap()),
            hmac = "valid-but-old",
            timestamp = System.currentTimeMillis() - 60_000 // 1 minute old
        )

        val result = CommandSigner.verify(oldCommand, sessionKey, maxAgeMs = 30_000)

        assertThat(result).isFalse()
    }
}
```

**Implementation (after tests):**
- Use TweetNaCl or libsodium-jni for Ed25519
- Implement X25519 for key exchange
- HKDF for session key derivation
- HMAC-SHA256 for command signing

### 1.2 Token Service

**Tests First:**
```kotlin
class TokenServiceTest {
    @Test
    fun `generates valid JWT`() {
        val deviceId = "device-123"
        val controllerId = "controller-456"

        val token = TokenService.generateSessionToken(
            deviceId = deviceId,
            controllerId = controllerId,
            expiresIn = Duration.ofMinutes(15)
        )

        val decoded = TokenService.decode(token)
        assertThat(decoded.deviceId).isEqualTo(deviceId)
        assertThat(decoded.controllerId).isEqualTo(controllerId)
        assertThat(decoded.expiresAt).isAfter(Instant.now())
    }

    @Test
    fun `rejects expired token`() {
        val token = TokenService.generateSessionToken(
            deviceId = "device-123",
            controllerId = "controller-456",
            expiresIn = Duration.ofMillis(-1) // Already expired
        )

        assertThrows<TokenExpiredException> {
            TokenService.validate(token)
        }
    }

    @Test
    fun `rejects tampered token`() {
        val token = TokenService.generateSessionToken(
            deviceId = "device-123",
            controllerId = "controller-456",
            expiresIn = Duration.ofMinutes(15)
        )

        val tamperedToken = token.dropLast(5) + "xxxxx"

        assertThrows<InvalidTokenException> {
            TokenService.validate(tamperedToken)
        }
    }
}
```

### 1.3 Pairing Protocol State Machine

**Tests First:**
```kotlin
class PairingStateMachineTest {
    @Test
    fun `initial state is IDLE`() {
        val machine = PairingStateMachine()
        assertThat(machine.state).isEqualTo(PairingState.IDLE)
    }

    @Test
    fun `transitions to AWAITING_CODE after generating pairing code`() {
        val machine = PairingStateMachine()

        val code = machine.generatePairingCode()

        assertThat(machine.state).isEqualTo(PairingState.AWAITING_CODE)
        assertThat(code).hasLength(6)
        assertThat(code).matches("[0-9]+")
    }

    @Test
    fun `transitions to EXCHANGING_KEYS on valid code entry`() {
        val machine = PairingStateMachine()
        val code = machine.generatePairingCode()

        machine.onCodeEntered(code)

        assertThat(machine.state).isEqualTo(PairingState.EXCHANGING_KEYS)
    }

    @Test
    fun `remains AWAITING_CODE on invalid code`() {
        val machine = PairingStateMachine()
        machine.generatePairingCode()

        machine.onCodeEntered("000000") // Wrong code

        assertThat(machine.state).isEqualTo(PairingState.AWAITING_CODE)
        assertThat(machine.failedAttempts).isEqualTo(1)
    }

    @Test
    fun `locks out after 3 failed attempts`() {
        val machine = PairingStateMachine()
        machine.generatePairingCode()

        repeat(3) { machine.onCodeEntered("000000") }

        assertThat(machine.state).isEqualTo(PairingState.LOCKED_OUT)
    }

    @Test
    fun `transitions to PAIRED after successful key exchange`() {
        val machine = PairingStateMachine()
        val code = machine.generatePairingCode()
        machine.onCodeEntered(code)

        val controllerPublicKey = CryptoService.generateKeyPair().publicKey
        machine.onKeyExchangeComplete(controllerPublicKey)

        assertThat(machine.state).isEqualTo(PairingState.PAIRED)
        assertThat(machine.sessionKey).isNotNull()
    }

    @Test
    fun `pairing code expires after timeout`() {
        val machine = PairingStateMachine(codeTimeoutMs = 100)
        machine.generatePairingCode()

        Thread.sleep(150)

        assertThat(machine.isPairingCodeValid()).isFalse()
    }
}
```

### 1.4 Server Pairing Endpoints

**Tests First (TypeScript):**
```typescript
// server/test/pairing.test.ts
describe('Pairing API', () => {
  describe('POST /api/pair/initiate', () => {
    it('creates pairing session and returns device ID', async () => {
      const response = await request(app)
        .post('/api/pair/initiate')
        .send({ devicePublicKey: mockDevicePublicKey });

      expect(response.status).toBe(201);
      expect(response.body.deviceId).toBeDefined();
      expect(response.body.pairingCode).toMatch(/^\d{6}$/);
    });
  });

  describe('POST /api/pair/complete', () => {
    it('completes pairing with valid code', async () => {
      // Setup: create pairing session
      const initResponse = await request(app)
        .post('/api/pair/initiate')
        .send({ devicePublicKey: mockDevicePublicKey });

      const response = await request(app)
        .post('/api/pair/complete')
        .send({
          pairingCode: initResponse.body.pairingCode,
          controllerPublicKey: mockControllerPublicKey
        });

      expect(response.status).toBe(200);
      expect(response.body.sessionToken).toBeDefined();
      expect(response.body.deviceId).toBe(initResponse.body.deviceId);
    });

    it('rejects invalid pairing code', async () => {
      const response = await request(app)
        .post('/api/pair/complete')
        .send({
          pairingCode: '000000',
          controllerPublicKey: mockControllerPublicKey
        });

      expect(response.status).toBe(401);
    });

    it('rate limits pairing attempts', async () => {
      const attempts = Array(10).fill(null).map(() =>
        request(app)
          .post('/api/pair/complete')
          .send({ pairingCode: '000000', controllerPublicKey: mockControllerPublicKey })
      );

      const responses = await Promise.all(attempts);
      const rateLimited = responses.filter(r => r.status === 429);

      expect(rateLimited.length).toBeGreaterThan(0);
    });
  });
});
```

### 1.5 PIN Verification (Second Factor)

**Tests First:**
```kotlin
class PinVerificationTest {
    @Test
    fun `verifies correct PIN`() {
        val pinService = PinService(storedPinHash = hashPin("1234"))

        val result = pinService.verify("1234")

        assertThat(result).isTrue()
    }

    @Test
    fun `rejects incorrect PIN`() {
        val pinService = PinService(storedPinHash = hashPin("1234"))

        val result = pinService.verify("0000")

        assertThat(result).isFalse()
    }

    @Test
    fun `locks out after 5 failed attempts`() {
        val pinService = PinService(storedPinHash = hashPin("1234"))

        repeat(5) { pinService.verify("0000") }

        assertThrows<PinLockoutException> {
            pinService.verify("1234") // Even correct PIN is rejected
        }
    }

    @Test
    fun `lockout expires after cooldown period`() {
        val pinService = PinService(
            storedPinHash = hashPin("1234"),
            lockoutDurationMs = 100
        )

        repeat(5) { pinService.verify("0000") }
        Thread.sleep(150)

        val result = pinService.verify("1234")

        assertThat(result).isTrue()
    }
}
```

---

## Phase 2: Non-Root MVP (Tests First)

### 2.1 Screen Capture Module (`feature-screen`)

**Tests First - Encoder Configuration:**
```kotlin
class EncoderConfigTest {
    @Test
    fun `creates valid H264 encoder config for 1080p`() {
        val config = EncoderConfig.forResolution(1920, 1080)

        assertThat(config.width).isEqualTo(1920)
        assertThat(config.height).isEqualTo(1080)
        assertThat(config.bitrate).isEqualTo(4_000_000) // 4 Mbps
        assertThat(config.frameRate).isEqualTo(30)
        assertThat(config.mimeType).isEqualTo("video/avc")
    }

    @Test
    fun `scales down for bandwidth constraints`() {
        val config = EncoderConfig.forResolution(1920, 1080)
            .withMaxBitrate(1_000_000)

        assertThat(config.width).isLessThanOrEqualTo(1280)
        assertThat(config.height).isLessThanOrEqualTo(720)
    }

    @Test
    fun `handles rotation correctly`() {
        val config = EncoderConfig.forResolution(1080, 1920, rotation = 90)

        assertThat(config.width).isEqualTo(1920)
        assertThat(config.height).isEqualTo(1080)
    }
}
```

**Tests First - Frame Processing:**
```kotlin
class FrameProcessorTest {
    @Test
    fun `converts VirtualDisplay frame to encoder input`() {
        val mockImage = createMockImage(1920, 1080, ImageFormat.RGBA_8888)
        val processor = FrameProcessor()

        val encoderInput = processor.process(mockImage)

        assertThat(encoderInput.format).isEqualTo(ColorFormat.YUV420)
        assertThat(encoderInput.presentationTimeUs).isGreaterThan(0)
    }

    @Test
    fun `skips duplicate frames`() {
        val processor = FrameProcessor()
        val frame1 = createMockImage(content = "frame1")
        val frame2 = createMockImage(content = "frame1") // Same content

        val result1 = processor.process(frame1)
        val result2 = processor.process(frame2)

        assertThat(result1).isNotNull()
        assertThat(result2).isNull() // Skipped
    }
}
```

**Instrumented Tests (Espresso + real MediaProjection):**
```kotlin
@RunWith(AndroidJUnit4::class)
@LargeTest
class ScreenCaptureServiceTest {
    @get:Rule
    val grantPermissionRule: GrantPermissionRule = GrantPermissionRule.grant(
        Manifest.permission.FOREGROUND_SERVICE,
        Manifest.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION
    )

    @Test
    fun serviceStartsWithMediaProjectionPermission() {
        // This test requires manual MediaProjection consent or test orchestration
        val scenario = ActivityScenario.launch(MainActivity::class.java)

        scenario.onActivity { activity ->
            val intent = Intent(activity, ScreenCaptureService::class.java)
            // Would need actual MediaProjection token from user consent
        }

        // Verify service started
        // Verify foreground notification shown
    }
}
```

### 2.2 Touch Injection Module (`feature-input`)

**Tests First - Coordinate Mapping:**
```kotlin
class CoordinateMappingTest {
    @Test
    fun `maps normalized coordinates to screen pixels`() {
        val mapper = CoordinateMapper(
            screenWidth = 1080,
            screenHeight = 2340,
            rotation = 0
        )

        val result = mapper.map(normalizedX = 0.5f, normalizedY = 0.5f)

        assertThat(result.x).isEqualTo(540)
        assertThat(result.y).isEqualTo(1170)
    }

    @Test
    fun `handles 90 degree rotation`() {
        val mapper = CoordinateMapper(
            screenWidth = 2340,
            screenHeight = 1080,
            rotation = 90
        )

        val result = mapper.map(normalizedX = 0.0f, normalizedY = 0.0f)

        // Top-left in portrait becomes different position in landscape
        assertThat(result.x).isEqualTo(0)
        assertThat(result.y).isEqualTo(0)
    }

    @Test
    fun `accounts for notch insets`() {
        val mapper = CoordinateMapper(
            screenWidth = 1080,
            screenHeight = 2340,
            rotation = 0,
            topInset = 100 // Notch
        )

        val result = mapper.map(normalizedX = 0.0f, normalizedY = 0.0f)

        assertThat(result.y).isEqualTo(100) // Offset by notch
    }
}
```

**Tests First - Gesture Building:**
```kotlin
class GestureBuilderTest {
    @Test
    fun `builds tap gesture`() {
        val gesture = GestureBuilder.tap(x = 540, y = 1170)

        assertThat(gesture.strokeCount).isEqualTo(1)
        assertThat(gesture.duration).isEqualTo(100L) // Quick tap
    }

    @Test
    fun `builds long press gesture`() {
        val gesture = GestureBuilder.longPress(x = 540, y = 1170)

        assertThat(gesture.strokeCount).isEqualTo(1)
        assertThat(gesture.duration).isGreaterThanOrEqualTo(500L)
    }

    @Test
    fun `builds swipe gesture`() {
        val gesture = GestureBuilder.swipe(
            startX = 540, startY = 1500,
            endX = 540, endY = 500,
            durationMs = 300
        )

        assertThat(gesture.strokeCount).isEqualTo(1)
        assertThat(gesture.duration).isEqualTo(300L)
    }

    @Test
    fun `builds pinch gesture for zoom`() {
        val gesture = GestureBuilder.pinch(
            centerX = 540, centerY = 1170,
            startDistance = 100, endDistance = 300, // Zoom in
            durationMs = 400
        )

        assertThat(gesture.strokeCount).isEqualTo(2) // Two fingers
    }
}
```

**Instrumented Tests (AccessibilityService):**
```kotlin
@RunWith(AndroidJUnit4::class)
class AccessibilityInjectionTest {
    @Test
    fun accessibilityServiceDispatchesTapGesture() {
        // Requires AccessibilityService to be enabled
        // Use UiAutomator to verify the tap landed

        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())

        // Trigger tap via your service
        InputInjectionService.instance?.dispatchTap(540, 1170)

        // Verify using UiAutomator that something was tapped
        // (e.g., if tapping a button, verify the button's onClick fired)
    }
}
```

### 2.3 Protocol Module (`core-protocol`)

**Tests First - Message Serialization:**
```kotlin
class MessageSerializationTest {
    @Test
    fun `serializes tap command`() {
        val command = TapCommand(x = 0.5f, y = 0.5f)

        val json = MessageSerializer.serialize(command)

        assertThat(json).isEqualTo("""{"type":"TAP","x":0.5,"y":0.5}""")
    }

    @Test
    fun `deserializes tap command`() {
        val json = """{"type":"TAP","x":0.5,"y":0.5}"""

        val command = MessageSerializer.deserialize<TapCommand>(json)

        assertThat(command.x).isEqualTo(0.5f)
        assertThat(command.y).isEqualTo(0.5f)
    }

    @Test
    fun `rejects malformed message`() {
        val malformed = """{"type":"TAP","x":"not-a-number"}"""

        assertThrows<MessageParseException> {
            MessageSerializer.deserialize<TapCommand>(malformed)
        }
    }
}
```

### 2.4 WebRTC Integration

**Tests First - Peer Connection:**
```kotlin
class WebRTCPeerConnectionTest {
    @Test
    fun `creates offer with video track`() = runTest {
        val peerConnection = WebRTCPeerConnection(mockPeerConnectionFactory)

        peerConnection.addVideoTrack(mockVideoTrack)
        val offer = peerConnection.createOffer()

        assertThat(offer.type).isEqualTo(SessionDescription.Type.OFFER)
        assertThat(offer.description).contains("video")
    }

    @Test
    fun `handles ICE candidate`() = runTest {
        val peerConnection = WebRTCPeerConnection(mockPeerConnectionFactory)
        val candidateReceived = CompletableDeferred<IceCandidate>()

        peerConnection.onIceCandidate = { candidateReceived.complete(it) }
        peerConnection.createOffer()

        val candidate = withTimeout(5000) { candidateReceived.await() }
        assertThat(candidate.sdp).isNotEmpty()
    }
}
```

---

## Phase 3: Extended Non-Root Features (Tests First)

### 3.1 File Transfer Module (`feature-files`)

**Tests First - SAF Operations:**
```kotlin
class SAFFileOperationsTest {
    @Test
    fun `lists files in granted directory`() {
        val mockDocumentTree = createMockDocumentTree(
            files = listOf("photo.jpg", "document.pdf", "video.mp4")
        )
        val fileService = SAFFileService(mockDocumentTree)

        val files = fileService.listFiles()

        assertThat(files).hasSize(3)
        assertThat(files.map { it.name }).containsExactly("photo.jpg", "document.pdf", "video.mp4")
    }

    @Test
    fun `reads file content`() {
        val mockDocumentTree = createMockDocumentTree(
            files = mapOf("test.txt" to "Hello, World!")
        )
        val fileService = SAFFileService(mockDocumentTree)

        val content = fileService.readFile("test.txt")

        assertThat(content.decodeToString()).isEqualTo("Hello, World!")
    }

    @Test
    fun `writes file content`() {
        val mockDocumentTree = createMockDocumentTree()
        val fileService = SAFFileService(mockDocumentTree)

        fileService.writeFile("new-file.txt", "New content".toByteArray())

        val written = fileService.readFile("new-file.txt")
        assertThat(written.decodeToString()).isEqualTo("New content")
    }

    @Test
    fun `handles permission denied`() {
        val restrictedTree = createMockDocumentTree(readable = false)
        val fileService = SAFFileService(restrictedTree)

        assertThrows<FileAccessDeniedException> {
            fileService.listFiles()
        }
    }
}
```

**Tests First - File Transfer Protocol:**
```kotlin
class FileTransferProtocolTest {
    @Test
    fun `chunks large file for transfer`() {
        val largeFile = ByteArray(10 * 1024 * 1024) // 10 MB
        val protocol = FileTransferProtocol(chunkSize = 1024 * 1024) // 1 MB chunks

        val chunks = protocol.chunk(largeFile)

        assertThat(chunks).hasSize(10)
        assertThat(chunks.sumOf { it.size }).isEqualTo(largeFile.size)
    }

    @Test
    fun `reassembles chunks correctly`() {
        val original = "Hello, World!".repeat(1000).toByteArray()
        val protocol = FileTransferProtocol(chunkSize = 100)

        val chunks = protocol.chunk(original)
        val reassembled = protocol.reassemble(chunks)

        assertThat(reassembled).isEqualTo(original)
    }

    @Test
    fun `includes checksum for integrity`() {
        val data = "Test data".toByteArray()
        val protocol = FileTransferProtocol()

        val packet = protocol.createPacket(data, sequenceNumber = 0)

        assertThat(packet.checksum).isEqualTo(CRC32.calculate(data))
    }
}
```

### 3.2 Camera Streaming Module (`feature-camera`)

**Tests First:**
```kotlin
class CameraStreamTest {
    @Test
    fun `opens back camera by default`() {
        val cameraService = CameraService(mockCameraManager)

        cameraService.open()

        verify { mockCameraManager.openCamera(eq("0"), any(), any()) }
    }

    @Test
    fun `switches between front and back camera`() {
        val cameraService = CameraService(mockCameraManager)
        cameraService.open()

        cameraService.switchCamera()

        verify { mockCameraManager.openCamera(eq("1"), any(), any()) }
    }

    @Test
    fun `provides video frames to encoder`() = runTest {
        val cameraService = CameraService(mockCameraManager)
        val frames = mutableListOf<VideoFrame>()

        cameraService.onFrame = { frames.add(it) }
        cameraService.open()
        cameraService.startCapture()

        advanceTimeBy(1000) // 1 second

        assertThat(frames.size).isGreaterThanOrEqualTo(25) // ~30fps
    }
}
```

### 3.3 Text Input Module

**Tests First:**
```kotlin
class TextInputTest {
    @Test
    fun `sets text via accessibility`() {
        val mockAccessibilityService = mockk<InputInjectionService>()
        val textInput = AccessibilityTextInput(mockAccessibilityService)

        textInput.setText("Hello, World!")

        verify {
            mockAccessibilityService.performAction(
                AccessibilityNodeInfo.ACTION_SET_TEXT,
                bundleOf(
                    AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE to "Hello, World!"
                )
            )
        }
    }

    @Test
    fun `falls back to clipboard paste when setText fails`() {
        val mockAccessibilityService = mockk<InputInjectionService> {
            every { performAction(any(), any()) } returns false
        }
        val mockClipboard = mockk<ClipboardManager>()
        val textInput = AccessibilityTextInput(mockAccessibilityService, mockClipboard)

        textInput.setText("Hello, World!")

        verify { mockClipboard.setPrimaryClip(any()) }
        verify { mockAccessibilityService.performAction(AccessibilityNodeInfo.ACTION_PASTE, null) }
    }
}
```

---

## Phase 4: Root Daemon (Tests First)

### 4.1 Rust Daemon - Core

**Tests First (Rust):**
```rust
// root-daemon/src/tests/auth_test.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_valid_command_signature() {
        let shared_secret = generate_secret();
        let command = Command::Tap { x: 100, y: 200 };
        let signed = sign_command(&command, &shared_secret);

        assert!(verify_signature(&signed, &shared_secret));
    }

    #[test]
    fn rejects_invalid_signature() {
        let shared_secret = generate_secret();
        let wrong_secret = generate_secret();
        let command = Command::Tap { x: 100, y: 200 };
        let signed = sign_command(&command, &shared_secret);

        assert!(!verify_signature(&signed, &wrong_secret));
    }

    #[test]
    fn rejects_commands_from_wrong_uid() {
        let daemon = Daemon::new(allowed_uid = 10123); // App's UID

        // Simulate command from different process
        let result = daemon.handle_command_from_uid(10456, Command::Tap { x: 0, y: 0 });

        assert!(matches!(result, Err(DaemonError::UnauthorizedCaller)));
    }
}
```

**Tests First - Input Injection:**
```rust
// root-daemon/src/tests/input_test.rs
#[test]
fn injects_tap_event() {
    let injector = InputInjector::new("/dev/uinput");

    let result = injector.tap(100, 200);

    assert!(result.is_ok());
    // Verify event was written to uinput
}

#[test]
fn injects_swipe_gesture() {
    let injector = InputInjector::new("/dev/uinput");

    let result = injector.swipe(
        start: (100, 200),
        end: (100, 800),
        duration_ms: 300
    );

    assert!(result.is_ok());
}

#[test]
fn injects_key_event() {
    let injector = InputInjector::new("/dev/uinput");

    let result = injector.key(KeyCode::BACK);

    assert!(result.is_ok());
}
```

### 4.2 Android-Daemon Bridge

**Tests First (Kotlin):**
```kotlin
class RootDaemonBridgeTest {
    @Test
    fun `connects to daemon via Unix socket`() = runTest {
        val bridge = RootDaemonBridge()

        bridge.connect()

        assertThat(bridge.isConnected).isTrue()
    }

    @Test
    fun `sends signed command to daemon`() = runTest {
        val bridge = RootDaemonBridge()
        val sessionKey = CryptoService.generateSessionKey()
        bridge.setSessionKey(sessionKey)
        bridge.connect()

        bridge.sendCommand(Command.Tap(100, 200))

        // Verify command was sent with correct signature
    }

    @Test
    fun `handles daemon disconnect gracefully`() = runTest {
        val bridge = RootDaemonBridge()
        bridge.connect()

        // Simulate daemon crash
        bridge.simulateDisconnect()

        assertThat(bridge.isConnected).isFalse()
        assertThrows<DaemonDisconnectedException> {
            bridge.sendCommand(Command.Tap(0, 0))
        }
    }
}
```

---

## Phase 5: Web UI (Tests First)

### 5.1 React Dashboard

**Tests First (Jest + React Testing Library):**
```typescript
// web-ui/src/tests/PairingFlow.test.tsx
describe('PairingFlow', () => {
  it('displays QR code for pairing', () => {
    render(<PairingFlow />);

    expect(screen.getByRole('img', { name: /pairing qr code/i })).toBeInTheDocument();
  });

  it('accepts manual code entry', async () => {
    render(<PairingFlow />);

    await userEvent.click(screen.getByText(/enter code manually/i));
    await userEvent.type(screen.getByLabelText(/pairing code/i), '123456');
    await userEvent.click(screen.getByRole('button', { name: /connect/i }));

    expect(screen.getByText(/connecting/i)).toBeInTheDocument();
  });

  it('shows error on invalid code', async () => {
    server.use(
      rest.post('/api/pair/complete', (req, res, ctx) => {
        return res(ctx.status(401), ctx.json({ error: 'Invalid code' }));
      })
    );

    render(<PairingFlow />);
    await userEvent.type(screen.getByLabelText(/pairing code/i), '000000');
    await userEvent.click(screen.getByRole('button', { name: /connect/i }));

    expect(await screen.findByText(/invalid code/i)).toBeInTheDocument();
  });
});

describe('RemoteScreen', () => {
  it('displays video stream', async () => {
    render(<RemoteScreen sessionToken="valid-token" />);

    await waitFor(() => {
      expect(screen.getByTestId('video-element')).toBeInTheDocument();
    });
  });

  it('sends tap on click', async () => {
    const onCommand = jest.fn();
    render(<RemoteScreen sessionToken="valid-token" onCommand={onCommand} />);

    const video = await screen.findByTestId('video-element');
    await userEvent.click(video, { clientX: 100, clientY: 200 });

    expect(onCommand).toHaveBeenCalledWith({
      type: 'TAP',
      x: expect.any(Number),
      y: expect.any(Number)
    });
  });

  it('sends swipe on drag', async () => {
    const onCommand = jest.fn();
    render(<RemoteScreen sessionToken="valid-token" onCommand={onCommand} />);

    const video = await screen.findByTestId('video-element');
    fireEvent.pointerDown(video, { clientX: 100, clientY: 200 });
    fireEvent.pointerMove(video, { clientX: 100, clientY: 400 });
    fireEvent.pointerUp(video, { clientX: 100, clientY: 400 });

    expect(onCommand).toHaveBeenCalledWith({
      type: 'SWIPE',
      startX: expect.any(Number),
      startY: expect.any(Number),
      endX: expect.any(Number),
      endY: expect.any(Number)
    });
  });
});
```

**Tests First - File Browser:**
```typescript
describe('FileBrowser', () => {
  it('displays file list', async () => {
    server.use(
      rest.get('/api/files', (req, res, ctx) => {
        return res(ctx.json({
          files: [
            { name: 'photo.jpg', type: 'file', size: 1024 },
            { name: 'Documents', type: 'directory' }
          ]
        }));
      })
    );

    render(<FileBrowser />);

    expect(await screen.findByText('photo.jpg')).toBeInTheDocument();
    expect(screen.getByText('Documents')).toBeInTheDocument();
  });

  it('uploads file', async () => {
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });

    render(<FileBrowser />);

    const input = screen.getByLabelText(/upload/i);
    await userEvent.upload(input, file);

    expect(await screen.findByText(/uploaded successfully/i)).toBeInTheDocument();
  });

  it('downloads file', async () => {
    render(<FileBrowser />);

    await userEvent.click(await screen.findByText('photo.jpg'));
    await userEvent.click(screen.getByRole('button', { name: /download/i }));

    // Verify download was triggered
  });
});
```

---

## CI/CD Pipeline

### GitHub Actions Workflow

```yaml
# .github/workflows/ci.yml
name: CI

on: [push, pull_request]

jobs:
  android-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up JDK 17
        uses: actions/setup-java@v4
        with:
          java-version: '17'
          distribution: 'temurin'

      - name: Run unit tests
        run: ./gradlew test

      - name: Run instrumented tests (emulator)
        uses: reactivecircus/android-emulator-runner@v2
        with:
          api-level: 34
          script: ./gradlew connectedAndroidTest

  server-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: cd server && npm ci

      - name: Run tests
        run: cd server && npm test

  rust-daemon-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Rust
        uses: actions-rs/toolchain@v1
        with:
          toolchain: stable

      - name: Run tests
        run: cd android/root-daemon && cargo test

  web-ui-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: cd web-ui && npm ci

      - name: Run tests
        run: cd web-ui && npm test
```

---

## Test Device Matrix

| Device | Android Version | Test Focus |
|--------|-----------------|------------|
| Pixel 7 (emulator) | 13 (API 33) | Baseline compatibility |
| Pixel 8 (emulator) | 14 (API 34) | FGS type requirements |
| Pixel 9 (emulator) | 15 (API 35) | Latest restrictions |
| Physical device 1 | 13 | Real hardware validation |
| Physical device 2 | 14+ | Real hardware + root testing |

---

## Milestone Checklist

### Milestone A: Non-Root MVP
- [ ] All crypto tests passing
- [ ] Pairing flow tests passing (Android + Server)
- [ ] Screen capture tests passing
- [ ] Touch injection tests passing
- [ ] Web UI basic tests passing
- [ ] End-to-end: pair device, see screen, send tap

### Milestone B: Full Non-Root
- [ ] File transfer tests passing
- [ ] Camera streaming tests passing
- [ ] Text input tests passing
- [ ] Multi-touch gesture tests passing

### Milestone C: Root Extension
- [ ] Rust daemon tests passing
- [ ] Android-daemon bridge tests passing
- [ ] Root input injection tests passing
- [ ] Full filesystem access tests passing

---

## Implementation Order (Tests First)

1. **Week 1-2:** Phase 0 + Phase 1 (Setup + Security)
   - Project skeleton with test infrastructure
   - Crypto module (TDD)
   - Pairing protocol (TDD)
   - Server pairing endpoints (TDD)

2. **Week 3-4:** Phase 2 (Screen + Touch)
   - Encoder config (TDD)
   - Coordinate mapping (TDD)
   - Gesture building (TDD)
   - WebRTC integration (TDD)
   - Basic web UI (TDD)

3. **Week 5-6:** Phase 3 (Extended Features)
   - SAF file operations (TDD)
   - File transfer protocol (TDD)
   - Camera streaming (TDD)
   - Text input (TDD)

4. **Week 7-8:** Phase 4 (Root)
   - Rust daemon core (TDD)
   - Input injection (TDD)
   - Android-daemon bridge (TDD)

5. **Ongoing:** Phase 5 (Polish + Compatibility)
   - Device compatibility testing
   - Performance optimization
   - Edge case handling
