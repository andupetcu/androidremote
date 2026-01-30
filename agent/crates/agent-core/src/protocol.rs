use bytes::{Buf, BufMut, BytesMut};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Header size: 1 (type) + 2 (length) + 2 (channel) + 4 (request_id) = 9 bytes
pub const HEADER_SIZE: usize = 9;

/// Maximum payload size (16 MB)
pub const MAX_PAYLOAD_SIZE: usize = 16 * 1024 * 1024;

// --- Command Types ---

// Control plane (channel 0)
pub const AUTH_REQUEST: u8 = 0x01;
pub const AUTH_RESPONSE: u8 = 0x02;
pub const HEARTBEAT: u8 = 0x03;
pub const HEARTBEAT_ACK: u8 = 0x04;
pub const AGENT_INFO: u8 = 0x05;
pub const COMMAND: u8 = 0x06;
pub const COMMAND_RESULT: u8 = 0x07;

// Desktop (channel 1+)
pub const DESKTOP_OPEN: u8 = 0x10;
pub const DESKTOP_CLOSE: u8 = 0x11;
pub const DESKTOP_FRAME: u8 = 0x12;
pub const DESKTOP_INPUT: u8 = 0x13;
pub const DESKTOP_RESIZE: u8 = 0x14;
pub const DESKTOP_QUALITY: u8 = 0x15;

// Terminal (channel 1+)
pub const TERMINAL_OPEN: u8 = 0x20;
pub const TERMINAL_CLOSE: u8 = 0x21;
pub const TERMINAL_DATA: u8 = 0x22;
pub const TERMINAL_RESIZE: u8 = 0x23;

// Files (channel 0)
pub const FILE_LIST_REQ: u8 = 0x30;
pub const FILE_LIST_RESP: u8 = 0x31;
pub const FILE_DOWNLOAD_REQ: u8 = 0x32;
pub const FILE_DOWNLOAD_DATA: u8 = 0x33;
pub const FILE_UPLOAD_START: u8 = 0x34;
pub const FILE_UPLOAD_DATA: u8 = 0x35;
pub const FILE_UPLOAD_DONE: u8 = 0x36;
pub const FILE_DELETE_REQ: u8 = 0x37;
pub const FILE_RESULT: u8 = 0x38;

// Telemetry (channel 0)
pub const TELEMETRY_REQ: u8 = 0x40;
pub const TELEMETRY_DATA: u8 = 0x41;

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("buffer too short: need {need} bytes, have {have}")]
    BufferTooShort { need: usize, have: usize },
    #[error("payload too large: {size} bytes (max {MAX_PAYLOAD_SIZE})")]
    PayloadTooLarge { size: usize },
    #[error("invalid message type: 0x{0:02x}")]
    InvalidType(u8),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

/// Raw message header
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub msg_type: u8,
    pub length: u16,
    pub channel: u16,
    pub request_id: u32,
}

/// A decoded protocol message
#[derive(Debug, Clone)]
pub struct Message {
    pub header: Header,
    pub payload: Vec<u8>,
}

impl Message {
    pub fn new(msg_type: u8, channel: u16, request_id: u32, payload: Vec<u8>) -> Self {
        Self {
            header: Header {
                msg_type,
                length: payload.len() as u16,
                channel,
                request_id,
            },
            payload,
        }
    }

    /// Create a control-plane message (channel 0)
    pub fn control(msg_type: u8, request_id: u32, payload: Vec<u8>) -> Self {
        Self::new(msg_type, 0, request_id, payload)
    }

    /// Create a control-plane message with JSON payload
    pub fn control_json<T: Serialize>(
        msg_type: u8,
        request_id: u32,
        data: &T,
    ) -> Result<Self, ProtocolError> {
        let payload = serde_json::to_vec(data)?;
        Ok(Self::control(msg_type, request_id, payload))
    }

    /// Create a session message (channel > 0)
    pub fn session(msg_type: u8, channel: u16, request_id: u32, payload: Vec<u8>) -> Self {
        Self::new(msg_type, channel, request_id, payload)
    }

    /// Parse the payload as JSON
    pub fn parse_json<'a, T: Deserialize<'a>>(&'a self) -> Result<T, ProtocolError> {
        Ok(serde_json::from_slice(&self.payload)?)
    }

    /// Encode this message into bytes
    pub fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(HEADER_SIZE + self.payload.len());
        buf.put_u8(self.header.msg_type);
        buf.put_u16_le(self.header.length);
        buf.put_u16_le(self.header.channel);
        buf.put_u32_le(self.header.request_id);
        buf.extend_from_slice(&self.payload);
        buf
    }

    /// Encode into an existing BytesMut buffer
    pub fn encode_into(&self, buf: &mut BytesMut) {
        buf.reserve(HEADER_SIZE + self.payload.len());
        buf.put_u8(self.header.msg_type);
        buf.put_u16_le(self.header.length);
        buf.put_u16_le(self.header.channel);
        buf.put_u32_le(self.header.request_id);
        buf.extend_from_slice(&self.payload);
    }

    /// Decode a message from bytes. Returns None if not enough data.
    pub fn decode(buf: &[u8]) -> Result<Option<(Message, usize)>, ProtocolError> {
        if buf.len() < HEADER_SIZE {
            return Ok(None);
        }

        let mut cursor = &buf[..];
        let msg_type = cursor.get_u8();
        let length = cursor.get_u16_le();
        let channel = cursor.get_u16_le();
        let request_id = cursor.get_u32_le();

        let payload_len = length as usize;
        let total_len = HEADER_SIZE + payload_len;

        if buf.len() < total_len {
            return Ok(None);
        }

        if payload_len > MAX_PAYLOAD_SIZE {
            return Err(ProtocolError::PayloadTooLarge { size: payload_len });
        }

        let payload = buf[HEADER_SIZE..total_len].to_vec();

        let msg = Message {
            header: Header {
                msg_type,
                length,
                channel,
                request_id,
            },
            payload,
        };

        Ok(Some((msg, total_len)))
    }
}

// --- JSON payload types for control-plane messages ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthRequest {
    pub token: String,
    #[serde(rename = "type")]
    pub device_type: String,
    pub agent_version: String,
    pub os: String,
    pub arch: String,
    pub hostname: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthResponse {
    pub success: bool,
    pub device_id: Option<String>,
    pub session_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub hostname: String,
    pub os_name: String,
    pub os_version: String,
    pub arch: String,
    pub agent_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disks: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopOpenRequest {
    #[serde(default = "default_quality")]
    pub quality: u8,
    #[serde(default = "default_fps")]
    pub fps: u16,
    #[serde(default = "default_encoding")]
    pub encoding: String,
}

fn default_quality() -> u8 {
    70
}
fn default_fps() -> u16 {
    15
}
fn default_encoding() -> String {
    "jpeg".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalOpenRequest {
    pub shell: Option<String>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
}

fn default_cols() -> u16 {
    80
}
fn default_rows() -> u16 {
    24
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileListRequest {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileDownloadRequest {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileUploadStart {
    pub path: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checksum: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileDeleteRequest {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Desktop input sub-types
pub mod desktop_input {
    pub const MOUSE_MOVE: u8 = 0x01;
    pub const MOUSE_BUTTON: u8 = 0x02;
    pub const MOUSE_SCROLL: u8 = 0x03;
    pub const KEY_EVENT: u8 = 0x04;
    pub const TYPE_TEXT: u8 = 0x05;
}

// --- Helper functions for building specific messages ---

/// Build a heartbeat message
pub fn heartbeat() -> Message {
    Message::control(HEARTBEAT, 0, vec![])
}

/// Build a heartbeat ACK message
pub fn heartbeat_ack() -> Message {
    Message::control(HEARTBEAT_ACK, 0, vec![])
}

/// Build an auth request message
pub fn auth_request(req: &AuthRequest) -> Result<Message, ProtocolError> {
    Message::control_json(AUTH_REQUEST, 0, req)
}

/// Build an auth response message
pub fn auth_response(resp: &AuthResponse) -> Result<Message, ProtocolError> {
    Message::control_json(AUTH_RESPONSE, 0, resp)
}

/// Build a terminal data message
pub fn terminal_data(channel: u16, data: Vec<u8>) -> Message {
    Message::session(TERMINAL_DATA, channel, 0, data)
}

/// Build a terminal resize message
pub fn terminal_resize(channel: u16, cols: u16, rows: u16) -> Message {
    let mut payload = Vec::with_capacity(4);
    payload.put_u16_le(cols);
    payload.put_u16_le(rows);
    Message::session(TERMINAL_RESIZE, channel, 0, payload)
}

/// Build a desktop frame message
pub fn desktop_frame(
    channel: u16,
    x: u16,
    y: u16,
    w: u16,
    h: u16,
    encoding: u8,
    flags: u8,
    data: Vec<u8>,
) -> Message {
    let mut payload = Vec::with_capacity(10 + data.len());
    payload.put_u16_le(x);
    payload.put_u16_le(y);
    payload.put_u16_le(w);
    payload.put_u16_le(h);
    payload.put_u8(encoding);
    payload.put_u8(flags);
    payload.extend_from_slice(&data);
    Message::session(DESKTOP_FRAME, channel, 0, payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_decode_roundtrip() {
        let msg = Message::control(HEARTBEAT, 42, vec![]);
        let encoded = msg.encode();
        assert_eq!(encoded.len(), HEADER_SIZE);

        let (decoded, consumed) = Message::decode(&encoded).unwrap().unwrap();
        assert_eq!(consumed, HEADER_SIZE);
        assert_eq!(decoded.header.msg_type, HEARTBEAT);
        assert_eq!(decoded.header.channel, 0);
        assert_eq!(decoded.header.request_id, 42);
        assert!(decoded.payload.is_empty());
    }

    #[test]
    fn test_encode_decode_with_payload() {
        let payload = b"hello world".to_vec();
        let msg = Message::new(AUTH_REQUEST, 0, 1, payload.clone());
        let encoded = msg.encode();
        assert_eq!(encoded.len(), HEADER_SIZE + payload.len());

        let (decoded, consumed) = Message::decode(&encoded).unwrap().unwrap();
        assert_eq!(consumed, HEADER_SIZE + payload.len());
        assert_eq!(decoded.header.msg_type, AUTH_REQUEST);
        assert_eq!(decoded.header.length, payload.len() as u16);
        assert_eq!(decoded.payload, payload);
    }

    #[test]
    fn test_decode_incomplete_header() {
        let buf = [0u8; 5]; // less than HEADER_SIZE
        assert!(Message::decode(&buf).unwrap().is_none());
    }

    #[test]
    fn test_decode_incomplete_payload() {
        let msg = Message::control(AGENT_INFO, 0, vec![1, 2, 3, 4, 5]);
        let encoded = msg.encode();
        // truncate to header + 2 bytes (payload is 5)
        let truncated = &encoded[..HEADER_SIZE + 2];
        assert!(Message::decode(truncated).unwrap().is_none());
    }

    #[test]
    fn test_json_roundtrip() {
        let req = AuthRequest {
            token: "test-token".to_string(),
            device_type: "linux".to_string(),
            agent_version: "0.1.0".to_string(),
            os: "linux".to_string(),
            arch: "x86_64".to_string(),
            hostname: "test-host".to_string(),
        };

        let msg = auth_request(&req).unwrap();
        assert_eq!(msg.header.msg_type, AUTH_REQUEST);

        let decoded_req: AuthRequest = msg.parse_json().unwrap();
        assert_eq!(decoded_req.token, "test-token");
        assert_eq!(decoded_req.hostname, "test-host");
    }

    #[test]
    fn test_heartbeat_messages() {
        let hb = heartbeat();
        assert_eq!(hb.header.msg_type, HEARTBEAT);
        assert!(hb.payload.is_empty());

        let hb_ack = heartbeat_ack();
        assert_eq!(hb_ack.header.msg_type, HEARTBEAT_ACK);
        assert!(hb_ack.payload.is_empty());
    }

    #[test]
    fn test_terminal_data_message() {
        let data = b"ls -la\n".to_vec();
        let msg = terminal_data(3, data.clone());
        assert_eq!(msg.header.msg_type, TERMINAL_DATA);
        assert_eq!(msg.header.channel, 3);
        assert_eq!(msg.payload, data);
    }

    #[test]
    fn test_terminal_resize_message() {
        let msg = terminal_resize(3, 120, 40);
        assert_eq!(msg.header.msg_type, TERMINAL_RESIZE);
        assert_eq!(msg.header.channel, 3);
        assert_eq!(msg.payload.len(), 4);

        let mut cursor = &msg.payload[..];
        let cols = cursor.get_u16_le();
        let rows = cursor.get_u16_le();
        assert_eq!(cols, 120);
        assert_eq!(rows, 40);
    }

    #[test]
    fn test_desktop_frame_message() {
        let jpeg_data = vec![0xFF, 0xD8, 0xFF, 0xE0]; // fake JPEG header
        let msg = desktop_frame(1, 64, 128, 64, 64, 0, 0, jpeg_data.clone());
        assert_eq!(msg.header.msg_type, DESKTOP_FRAME);
        assert_eq!(msg.header.channel, 1);
        // 2+2+2+2+1+1 = 10 bytes header + 4 bytes data
        assert_eq!(msg.payload.len(), 10 + jpeg_data.len());
    }

    #[test]
    fn test_multiple_messages_in_buffer() {
        let msg1 = heartbeat();
        let msg2 = heartbeat_ack();
        let mut buf = msg1.encode();
        buf.extend_from_slice(&msg2.encode());

        let (decoded1, consumed1) = Message::decode(&buf).unwrap().unwrap();
        assert_eq!(decoded1.header.msg_type, HEARTBEAT);

        let (decoded2, consumed2) = Message::decode(&buf[consumed1..]).unwrap().unwrap();
        assert_eq!(decoded2.header.msg_type, HEARTBEAT_ACK);
        assert_eq!(consumed1 + consumed2, buf.len());
    }

    #[test]
    fn test_session_message() {
        let msg = Message::session(DESKTOP_OPEN, 5, 100, b"{}".to_vec());
        assert_eq!(msg.header.msg_type, DESKTOP_OPEN);
        assert_eq!(msg.header.channel, 5);
        assert_eq!(msg.header.request_id, 100);
    }
}
