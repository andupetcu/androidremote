//! Screen capture auto-detection for Linux.
//! Supports X11 (xcb + SHM) and Wayland (xdg-desktop-portal + PipeWire/GStreamer).

use anyhow::{Result, bail};
use agent_platform::screen::ScreenCapture;

pub use crate::screen_x11::X11ScreenCapture;
pub use crate::screen_wayland::WaylandScreenCapture;

/// Detect the display server and return the appropriate ScreenCapture implementation.
pub fn create_screen_capture() -> Result<Box<dyn ScreenCapture>> {
    // Prefer X11 if DISPLAY is set (works for X11 and XWayland)
    if std::env::var("DISPLAY").is_ok() {
        tracing::info!("detected X11 display, using xcb screen capture");
        return Ok(Box::new(X11ScreenCapture::new()));
    }

    // Fall back to Wayland via xdg-desktop-portal
    if std::env::var("WAYLAND_DISPLAY").is_ok() {
        tracing::info!("detected Wayland display, using portal + PipeWire screen capture");
        return Ok(Box::new(WaylandScreenCapture::new()));
    }

    bail!("no display server detected — set DISPLAY for X11 or WAYLAND_DISPLAY for Wayland");
}
