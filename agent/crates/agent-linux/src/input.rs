//! Input injection auto-detection for Linux.
//! Currently supports X11 only. Wayland (uinput) is planned for Phase 7.

use anyhow::{Result, bail};
use agent_platform::input::InputInjector;

pub use crate::input_x11::X11InputInjector;

/// Detect the display server and return the appropriate InputInjector implementation.
pub fn create_input_injector() -> Result<Box<dyn InputInjector>> {
    if std::env::var("DISPLAY").is_ok() {
        let mut injector = X11InputInjector::new();
        injector.init()?;
        tracing::info!("using X11 input injection (XTest)");
        return Ok(Box::new(injector));
    }

    if std::env::var("WAYLAND_DISPLAY").is_ok() {
        bail!("Wayland input injection is not yet implemented (planned for Phase 7).");
    }

    bail!("no display server detected for input injection");
}
