//! X11 screen capture using xcb with SHM extension for zero-copy frame grabs.

use anyhow::{Context, Result, bail};
use agent_platform::screen::{ScreenCapture, ScreenFrame};
use async_trait::async_trait;

/// X11 screen capture using xcb + SHM
pub struct X11ScreenCapture {
    conn: xcb::Connection,
    screen_num: i32,
    width: u32,
    height: u32,
    root: u32,
    shm_seg: u32,
    shm_id: i32,
    shm_ptr: *mut u8,
    shm_size: usize,
    initialized: bool,
}

// SAFETY: The SHM pointer is only used from this struct's methods
// and xcb::Connection is thread-safe when accessed serially
unsafe impl Send for X11ScreenCapture {}
unsafe impl Sync for X11ScreenCapture {}

impl X11ScreenCapture {
    pub fn new() -> Self {
        Self {
            conn: unsafe { std::mem::zeroed() },
            screen_num: 0,
            width: 0,
            height: 0,
            root: 0,
            shm_seg: 0,
            shm_id: -1,
            shm_ptr: std::ptr::null_mut(),
            shm_size: 0,
            initialized: false,
        }
    }

    fn setup_shm(&mut self) -> Result<()> {
        let size = (self.width * self.height * 4) as usize;

        // Create POSIX shared memory segment
        self.shm_id = unsafe {
            libc::shmget(
                libc::IPC_PRIVATE,
                size,
                libc::IPC_CREAT | 0o600,
            )
        };
        if self.shm_id < 0 {
            bail!("shmget failed: {}", std::io::Error::last_os_error());
        }

        // Attach the shared memory
        let ptr = unsafe { libc::shmat(self.shm_id, std::ptr::null(), 0) };
        if ptr == (-1isize) as *mut libc::c_void {
            unsafe { libc::shmctl(self.shm_id, libc::IPC_RMID, std::ptr::null_mut()) };
            bail!("shmat failed: {}", std::io::Error::last_os_error());
        }
        self.shm_ptr = ptr as *mut u8;
        self.shm_size = size;

        // Mark for removal on last detach
        unsafe { libc::shmctl(self.shm_id, libc::IPC_RMID, std::ptr::null_mut()) };

        // Create xcb SHM segment
        self.shm_seg = self.conn.generate_id();
        let cookie = xcb::shm::attach_checked(
            &self.conn,
            self.shm_seg,
            self.shm_id as u32,
            false,
        );
        cookie.request_check()
            .context("xcb::shm::attach failed")?;

        Ok(())
    }

    fn cleanup_shm(&mut self) {
        if self.initialized {
            let _ = xcb::shm::detach_checked(&self.conn, self.shm_seg)
                .request_check();
        }
        if !self.shm_ptr.is_null() {
            unsafe { libc::shmdt(self.shm_ptr as *const libc::c_void) };
            self.shm_ptr = std::ptr::null_mut();
        }
    }
}

impl Drop for X11ScreenCapture {
    fn drop(&mut self) {
        self.cleanup_shm();
    }
}

#[async_trait]
impl ScreenCapture for X11ScreenCapture {
    async fn init(&mut self) -> Result<(u32, u32)> {
        let (conn, screen_num) = xcb::Connection::connect(None)
            .context("failed to connect to X11 display")?;

        let setup = conn.get_setup();
        let screen = setup
            .roots()
            .nth(screen_num as usize)
            .context("no X11 screen found")?;

        self.width = screen.width_in_pixels() as u32;
        self.height = screen.height_in_pixels() as u32;
        self.root = screen.root();
        self.screen_num = screen_num;
        self.conn = conn;

        // Check for SHM extension
        let shm_query = xcb::shm::query_version(&self.conn);
        shm_query.get_reply()
            .context("X11 SHM extension not available")?;

        self.setup_shm()?;
        self.initialized = true;

        tracing::info!(
            "X11 screen capture initialized: {}x{} on screen {}",
            self.width, self.height, self.screen_num
        );

        Ok((self.width, self.height))
    }

    async fn capture_frame(&mut self) -> Result<ScreenFrame> {
        if !self.initialized {
            bail!("screen capture not initialized");
        }

        // Use SHM GetImage for zero-copy screen capture
        let cookie = xcb::shm::get_image(
            &self.conn,
            self.root,
            0, 0,
            self.width as u16,
            self.height as u16,
            !0u32, // all planes
            xcb::x::IMAGE_FORMAT_Z_PIXMAP as u8,
            self.shm_seg,
            0,
        );

        cookie.get_reply()
            .context("xcb::shm::get_image failed")?;

        // Copy from shared memory — data is in BGRA format
        let data = unsafe {
            std::slice::from_raw_parts(self.shm_ptr, self.shm_size).to_vec()
        };

        Ok(ScreenFrame {
            width: self.width,
            height: self.height,
            data,
            stride: self.width * 4,
        })
    }

    fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }
}
