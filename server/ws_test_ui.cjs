const WebSocket = require('ws');

// Simulate the Android device side
const deviceId = 'test-device-123';
let pc = null;

console.log('=== Android Device Simulator ===');
console.log('Waiting for web UI to connect with device ID:', deviceId);
console.log('Open http://localhost:5173 and enter:', deviceId);
console.log('');

const ws = new WebSocket('ws://localhost:7899/ws');

ws.on('open', () => {
  console.log('[Device] Connected to signaling');
  ws.send(JSON.stringify({ type: 'join', deviceId, role: 'device' }));
});

ws.on('message', async (data) => {
  const msg = JSON.parse(data.toString());
  console.log('[Device] Received:', msg.type);
  
  if (msg.type === 'peer-joined' && msg.role === 'controller') {
    console.log('[Device] ✓ Web UI connected!');
  }
  
  if (msg.type === 'offer') {
    console.log('[Device] ✓ Received WebRTC offer');
    console.log('[Device] SDP preview:', msg.sdp?.substring(0, 100) + '...');
    
    // Send a mock answer (won't establish real connection but tests protocol)
    console.log('[Device] Sending mock answer...');
    ws.send(JSON.stringify({ 
      type: 'answer', 
      sdp: 'v=0\r\no=- 1234 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=ice-ufrag:mock\r\na=ice-pwd:mockpassword12345678901234\r\na=fingerprint:sha-256 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00\r\na=setup:active\r\na=mid:0\r\na=sctp-port:5000\r\n'
    }));
  }
  
  if (msg.type === 'ice-candidate') {
    console.log('[Device] ✓ Received ICE candidate');
  }
});

ws.on('error', (e) => console.log('[Device] Error:', e.message));

// Keep running for 2 minutes
setTimeout(() => {
  console.log('\nTest timeout. Closing...');
  ws.close();
  process.exit(0);
}, 120000);
