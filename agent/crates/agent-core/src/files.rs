use anyhow::Result;
use tracing::{error, info, warn};

use agent_platform::filesystem::FileSystem;
use crate::connection::ConnectionHandle;
use crate::protocol::{self, Message};

/// Chunk size for file downloads (64 KB)
const DOWNLOAD_CHUNK_SIZE: usize = 64 * 1024;

/// Handles file operation messages (channel 0, request-response)
pub struct FileHandler {
    fs: Box<dyn FileSystem>,
}

impl FileHandler {
    pub fn new(fs: Box<dyn FileSystem>) -> Self {
        Self { fs }
    }

    /// Process a file operation message and send response(s) back
    pub async fn handle_message(&self, msg: Message, handle: &ConnectionHandle) {
        let request_id = msg.header.request_id;

        let result = match msg.header.msg_type {
            protocol::FILE_LIST_REQ => self.handle_list(msg, handle).await,
            protocol::FILE_DOWNLOAD_REQ => self.handle_download(msg, handle).await,
            protocol::FILE_UPLOAD_START => self.handle_upload_start(msg, handle).await,
            protocol::FILE_DELETE_REQ => self.handle_delete(msg, handle).await,
            _ => {
                warn!("file handler: unexpected message type 0x{:02x}", msg.header.msg_type);
                return;
            }
        };

        if let Err(e) = result {
            error!("file operation failed: {:#}", e);
            let _ = send_file_result(handle, request_id, false, Some(format!("{:#}", e))).await;
        }
    }

    async fn handle_list(&self, msg: Message, handle: &ConnectionHandle) -> Result<()> {
        let req: protocol::FileListRequest = msg.parse_json()
            .map_err(|e| anyhow::anyhow!("invalid FILE_LIST_REQ: {}", e))?;

        info!("file list: {}", req.path);

        let entries = self.fs.list_dir(&req.path)?;
        let resp = serde_json::to_vec(&entries)?;

        let reply = Message::control(protocol::FILE_LIST_RESP, msg.header.request_id, resp);
        handle.send_message(&reply).await?;
        Ok(())
    }

    async fn handle_download(&self, msg: Message, handle: &ConnectionHandle) -> Result<()> {
        let req: protocol::FileDownloadRequest = msg.parse_json()
            .map_err(|e| anyhow::anyhow!("invalid FILE_DOWNLOAD_REQ: {}", e))?;

        info!("file download: {}", req.path);

        let data = self.fs.read_file(&req.path)?;
        let total_chunks = if data.is_empty() {
            1
        } else {
            (data.len() + DOWNLOAD_CHUNK_SIZE - 1) / DOWNLOAD_CHUNK_SIZE
        };

        for (seq, chunk) in data.chunks(DOWNLOAD_CHUNK_SIZE.max(1)).enumerate() {
            let mut payload = Vec::with_capacity(8 + chunk.len());
            payload.extend_from_slice(&(seq as u32).to_le_bytes());
            payload.extend_from_slice(&(total_chunks as u32).to_le_bytes());
            payload.extend_from_slice(chunk);

            let reply = Message::control(
                protocol::FILE_DOWNLOAD_DATA,
                msg.header.request_id,
                payload,
            );
            handle.send_message(&reply).await?;
        }

        // For empty files, send a single empty chunk
        if data.is_empty() {
            let mut payload = Vec::with_capacity(8);
            payload.extend_from_slice(&0u32.to_le_bytes()); // seq 0
            payload.extend_from_slice(&1u32.to_le_bytes()); // total 1
            let reply = Message::control(
                protocol::FILE_DOWNLOAD_DATA,
                msg.header.request_id,
                payload,
            );
            handle.send_message(&reply).await?;
        }

        Ok(())
    }

    async fn handle_upload_start(&self, msg: Message, handle: &ConnectionHandle) -> Result<()> {
        let req: protocol::FileUploadStart = msg.parse_json()
            .map_err(|e| anyhow::anyhow!("invalid FILE_UPLOAD_START: {}", e))?;

        info!("file upload start: {} ({} bytes)", req.path, req.size);

        // For now, we store the upload path and expect FILE_UPLOAD_DATA messages
        // to follow on the same request_id. Since channel 0 is used and the relay
        // forwards viewer messages directly, the viewer will send the data.
        //
        // Store upload state so FILE_UPLOAD_DATA can accumulate bytes.
        // This is handled by the caller (session manager) which tracks upload state.
        //
        // Acknowledge the upload request
        send_file_result(handle, msg.header.request_id, true, None).await?;
        Ok(())
    }

    async fn handle_delete(&self, msg: Message, handle: &ConnectionHandle) -> Result<()> {
        let req: protocol::FileDeleteRequest = msg.parse_json()
            .map_err(|e| anyhow::anyhow!("invalid FILE_DELETE_REQ: {}", e))?;

        info!("file delete: {}", req.path);

        self.fs.delete(&req.path)?;
        send_file_result(handle, msg.header.request_id, true, None).await?;
        Ok(())
    }

    /// Handle incoming upload data chunk and write to disk when complete
    pub async fn handle_upload_data(
        &self,
        path: &str,
        data: &[u8],
        handle: &ConnectionHandle,
        request_id: u32,
    ) -> Result<()> {
        self.fs.write_file(path, data)?;

        let done_resp = protocol::FileResult {
            success: true,
            error: None,
        };
        let reply = Message::control_json(protocol::FILE_UPLOAD_DONE, request_id, &done_resp)?;
        handle.send_message(&reply).await?;

        info!("file upload complete: {} ({} bytes)", path, data.len());
        Ok(())
    }
}

async fn send_file_result(
    handle: &ConnectionHandle,
    request_id: u32,
    success: bool,
    error: Option<String>,
) -> Result<()> {
    let result = protocol::FileResult { success, error };
    let msg = Message::control_json(protocol::FILE_RESULT, request_id, &result)?;
    handle.send_message(&msg).await?;
    Ok(())
}
