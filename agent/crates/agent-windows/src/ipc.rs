// Named pipe IPC for service ↔ helper communication.
//
// The service (Session 0) creates a named pipe server.
// The helper (user session) connects as a client.
// Messages are length-prefixed: [u32 LE total_len][encoded Message bytes]

#[cfg(target_os = "windows")]
use anyhow::{bail, Result};
#[cfg(target_os = "windows")]
use tracing::info;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{
    CloseHandle, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
    GetLastError, ERROR_IO_PENDING, ERROR_PIPE_CONNECTED,
};
#[cfg(target_os = "windows")]
use windows::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_ATTRIBUTE_NORMAL,
    FILE_FLAG_OVERLAPPED, FILE_SHARE_NONE, OPEN_EXISTING,
    FILE_GENERIC_READ, FILE_GENERIC_WRITE,
};
#[cfg(target_os = "windows")]
use windows::Win32::System::Pipes::{
    CreateNamedPipeW, ConnectNamedPipe, DisconnectNamedPipe,
    PIPE_TYPE_BYTE, PIPE_READMODE_BYTE, PIPE_WAIT,
};
#[cfg(target_os = "windows")]
use windows::Win32::System::IO::{
    GetOverlappedResult, OVERLAPPED,
};
#[cfg(target_os = "windows")]
use windows::Win32::System::Threading::{
    CreateEventW, WaitForSingleObject, INFINITE,
};
#[cfg(target_os = "windows")]
use windows::core::PCWSTR;

/// Pipe buffer size (256 KB)
#[cfg(target_os = "windows")]
const PIPE_BUFFER_SIZE: u32 = 256 * 1024;

/// Maximum message size over IPC (16 MB, matching protocol::MAX_PAYLOAD_SIZE)
#[cfg(target_os = "windows")]
const MAX_IPC_MESSAGE_SIZE: u32 = 16 * 1024 * 1024;

/// PIPE_ACCESS_DUPLEX = 0x00000003 (not always exported as a named constant in windows 0.58)
#[cfg(target_os = "windows")]
const PIPE_ACCESS_DUPLEX: u32 = 0x00000003;

/// Named pipe server (used by the service process in Session 0).
#[cfg(target_os = "windows")]
pub struct IpcServer {
    handle: isize, // raw HANDLE value — isize is Send
    pipe_name: String,
}

/// Named pipe client (used by the helper process in the user session).
#[cfg(target_os = "windows")]
pub struct IpcClient {
    handle: isize,
}

/// A split reader half for the IPC connection.
#[cfg(target_os = "windows")]
pub struct IpcReader {
    handle: isize,
}

/// A split writer half for the IPC connection.
#[cfg(target_os = "windows")]
pub struct IpcWriter {
    handle: isize,
}

// isize is Send+Sync, so these impls are automatic,
// but we need them because HANDLE is conceptually a kernel object handle.
#[cfg(target_os = "windows")]
unsafe impl Send for IpcServer {}
#[cfg(target_os = "windows")]
unsafe impl Sync for IpcServer {}
#[cfg(target_os = "windows")]
unsafe impl Send for IpcClient {}
#[cfg(target_os = "windows")]
unsafe impl Sync for IpcClient {}
#[cfg(target_os = "windows")]
unsafe impl Send for IpcReader {}
#[cfg(target_os = "windows")]
unsafe impl Sync for IpcReader {}
#[cfg(target_os = "windows")]
unsafe impl Send for IpcWriter {}
#[cfg(target_os = "windows")]
unsafe impl Sync for IpcWriter {}

#[cfg(target_os = "windows")]
fn to_wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// Reconstruct a HANDLE from its raw isize value.
#[cfg(target_os = "windows")]
#[inline]
fn h(raw: isize) -> HANDLE {
    HANDLE(raw as *mut std::ffi::c_void)
}

#[cfg(target_os = "windows")]
impl IpcServer {
    /// Create a new named pipe server.
    pub fn create(pipe_name: &str) -> Result<Self> {
        let wide_name = to_wide(pipe_name);

        let handle = unsafe {
            CreateNamedPipeW(
                PCWSTR(wide_name.as_ptr()),
                // PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED
                windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES(
                    PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED.0,
                ),
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                1,                  // max instances
                PIPE_BUFFER_SIZE,   // out buffer
                PIPE_BUFFER_SIZE,   // in buffer
                0,                  // default timeout
                None,               // default security
            )
        };

        if handle == INVALID_HANDLE_VALUE {
            bail!("CreateNamedPipeW failed: {}", std::io::Error::last_os_error());
        }

        info!("IPC server created: {}", pipe_name);

        Ok(Self {
            handle: handle.0 as isize,
            pipe_name: pipe_name.to_string(),
        })
    }

    /// Wait for a client (helper process) to connect.
    pub async fn wait_for_connection(&self) -> Result<()> {
        let raw_handle = self.handle;
        let pipe_name = self.pipe_name.clone();

        tokio::task::spawn_blocking(move || {
            unsafe {
                let handle = h(raw_handle);
                let event = CreateEventW(None, true, false, None)?;
                let mut overlapped = OVERLAPPED::default();
                overlapped.hEvent = event;

                let result = ConnectNamedPipe(handle, Some(&mut overlapped));

                if result.is_err() {
                    let err = GetLastError();
                    if err == ERROR_IO_PENDING {
                        let wait = WaitForSingleObject(event, INFINITE);
                        let _ = CloseHandle(event);
                        if wait != WAIT_OBJECT_0 {
                            bail!("WaitForSingleObject failed waiting for pipe connection");
                        }
                    } else if err == ERROR_PIPE_CONNECTED {
                        let _ = CloseHandle(event);
                    } else {
                        let _ = CloseHandle(event);
                        bail!("ConnectNamedPipe failed: {:?}", err);
                    }
                } else {
                    let _ = CloseHandle(event);
                }

                info!("IPC client connected to {}", pipe_name);
                Ok(())
            }
        })
        .await?
    }

    /// Split this server connection into reader and writer halves.
    /// Note: after split, the server Drop will NOT close the handle
    /// (caller is responsible via IpcReader/IpcWriter).
    pub fn split(self) -> (IpcReader, IpcWriter) {
        let raw = self.handle;
        // Prevent Drop from closing the handle — we transfer ownership to reader/writer
        std::mem::forget(self);
        (
            IpcReader { handle: raw },
            IpcWriter { handle: raw },
        )
    }

    /// Get the pipe name.
    pub fn pipe_name(&self) -> &str {
        &self.pipe_name
    }
}

#[cfg(target_os = "windows")]
impl IpcClient {
    /// Connect to an existing named pipe server.
    pub fn connect(pipe_name: &str) -> Result<Self> {
        let wide_name = to_wide(pipe_name);

        let handle = unsafe {
            CreateFileW(
                PCWSTR(wide_name.as_ptr()),
                (FILE_GENERIC_READ | FILE_GENERIC_WRITE).0,
                FILE_SHARE_NONE,
                None,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OVERLAPPED,
                None,
            )?
        };

        if handle == INVALID_HANDLE_VALUE {
            bail!("CreateFileW for pipe returned INVALID_HANDLE_VALUE");
        }

        info!("IPC client connected to {}", pipe_name);

        Ok(Self { handle: handle.0 as isize })
    }

    /// Split this client connection into reader and writer halves.
    pub fn split(self) -> (IpcReader, IpcWriter) {
        let raw = self.handle;
        std::mem::forget(self);
        (
            IpcReader { handle: raw },
            IpcWriter { handle: raw },
        )
    }
}

#[cfg(target_os = "windows")]
impl IpcReader {
    /// Read a single length-prefixed message from the pipe.
    ///
    /// Wire format: [u32 LE message_len][message_bytes...]
    pub async fn recv_raw(&mut self) -> Result<Vec<u8>> {
        let len_bytes = self.read_exact(4).await?;
        let msg_len = u32::from_le_bytes([len_bytes[0], len_bytes[1], len_bytes[2], len_bytes[3]]);

        if msg_len > MAX_IPC_MESSAGE_SIZE {
            bail!(
                "IPC message too large: {} bytes (max {})",
                msg_len,
                MAX_IPC_MESSAGE_SIZE
            );
        }

        if msg_len == 0 {
            bail!("IPC received zero-length message");
        }

        self.read_exact(msg_len as usize).await
    }

    /// Read exactly `n` bytes from the pipe, using overlapped I/O
    /// dispatched to the blocking thread pool.
    async fn read_exact(&mut self, n: usize) -> Result<Vec<u8>> {
        let raw_handle = self.handle;
        // Allocate the buffer here then send it into spawn_blocking
        let mut result = vec![0u8; n];

        // We do the whole read_exact in a single spawn_blocking call
        // to avoid per-chunk overhead and the Send issue with partial buffer pointers.
        let result = tokio::task::spawn_blocking(move || -> Result<Vec<u8>> {
            let handle = h(raw_handle);
            let mut offset = 0;

            while offset < n {
                unsafe {
                    let event = CreateEventW(None, true, false, None)?;
                    let mut overlapped = OVERLAPPED::default();
                    overlapped.hEvent = event;

                    let mut bytes_read: u32 = 0;

                    let ok = ReadFile(
                        handle,
                        Some(&mut result[offset..]),
                        Some(&mut bytes_read),
                        Some(&mut overlapped),
                    );

                    if ok.is_err() {
                        let err = GetLastError();
                        if err == ERROR_IO_PENDING {
                            let wait = WaitForSingleObject(event, INFINITE);
                            if wait != WAIT_OBJECT_0 {
                                let _ = CloseHandle(event);
                                bail!("WaitForSingleObject failed during pipe read");
                            }
                            GetOverlappedResult(handle, &overlapped, &mut bytes_read, false)?;
                        } else {
                            let _ = CloseHandle(event);
                            bail!("ReadFile failed: {:?}", err);
                        }
                    }

                    let _ = CloseHandle(event);

                    if bytes_read == 0 {
                        bail!("pipe disconnected (read returned 0 bytes)");
                    }

                    offset += bytes_read as usize;
                }
            }

            Ok(result)
        })
        .await??;

        Ok(result)
    }
}

#[cfg(target_os = "windows")]
impl IpcWriter {
    /// Send a length-prefixed message over the pipe.
    ///
    /// Wire format: [u32 LE message_len][message_bytes...]
    pub async fn send_raw(&self, data: &[u8]) -> Result<()> {
        let len = data.len() as u32;
        let mut buf = Vec::with_capacity(4 + data.len());
        buf.extend_from_slice(&len.to_le_bytes());
        buf.extend_from_slice(data);

        self.write_all(buf).await
    }

    /// Write all bytes to the pipe using overlapped I/O.
    async fn write_all(&self, data: Vec<u8>) -> Result<()> {
        let raw_handle = self.handle;

        tokio::task::spawn_blocking(move || {
            let handle = h(raw_handle);
            let mut offset = 0;
            while offset < data.len() {
                unsafe {
                    let event = CreateEventW(None, true, false, None)?;
                    let mut overlapped = OVERLAPPED::default();
                    overlapped.hEvent = event;

                    let mut bytes_written: u32 = 0;

                    let ok = WriteFile(
                        handle,
                        Some(&data[offset..]),
                        Some(&mut bytes_written),
                        Some(&mut overlapped),
                    );

                    if ok.is_err() {
                        let err = GetLastError();
                        if err == ERROR_IO_PENDING {
                            let wait = WaitForSingleObject(event, INFINITE);
                            if wait != WAIT_OBJECT_0 {
                                let _ = CloseHandle(event);
                                bail!("WaitForSingleObject failed during pipe write");
                            }
                            GetOverlappedResult(handle, &overlapped, &mut bytes_written, false)?;
                        } else {
                            let _ = CloseHandle(event);
                            bail!("WriteFile failed: {:?}", err);
                        }
                    }

                    let _ = CloseHandle(event);

                    if bytes_written == 0 {
                        bail!("pipe disconnected (write returned 0 bytes)");
                    }

                    offset += bytes_written as usize;
                }
            }
            Ok(())
        })
        .await?
    }
}

#[cfg(target_os = "windows")]
impl Drop for IpcServer {
    fn drop(&mut self) {
        unsafe {
            let handle = h(self.handle);
            let _ = DisconnectNamedPipe(handle);
            let _ = CloseHandle(handle);
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for IpcClient {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(h(self.handle));
        }
    }
}

// Reader closes the handle when dropped (it owns the handle after split)
#[cfg(target_os = "windows")]
impl Drop for IpcReader {
    fn drop(&mut self) {
        // Note: both reader and writer share the same handle.
        // Only one should close it. We let the reader close it
        // since the writer is typically dropped first (Arc<Mutex<Writer>>).
        // In practice, closing an already-closed handle is harmless on Windows.
        unsafe {
            let _ = CloseHandle(h(self.handle));
        }
    }
}

/// Generate the standard pipe name for a given device ID.
#[cfg(target_os = "windows")]
pub fn pipe_name_for_device(device_id: &str) -> String {
    format!(r"\\.\pipe\android-remote-agent-{}", device_id)
}
