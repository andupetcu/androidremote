use anyhow::Result;
use async_trait::async_trait;

/// Raw screen frame data from a capture
pub struct ScreenFrame {
    /// Width in pixels
    pub width: u32,
    /// Height in pixels
    pub height: u32,
    /// Raw BGRA pixel data
    pub data: Vec<u8>,
    /// Stride (bytes per row)
    pub stride: u32,
}

#[async_trait]
pub trait ScreenCapture: Send + Sync {
    /// Initialize screen capture, returns (width, height)
    async fn init(&mut self) -> Result<(u32, u32)>;

    /// Capture the current screen frame
    async fn capture_frame(&mut self) -> Result<ScreenFrame>;

    /// Get current screen dimensions
    fn dimensions(&self) -> (u32, u32);
}
