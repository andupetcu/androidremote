//! Wayland screen capture via xdg-desktop-portal + PipeWire.
//!
//! Uses the org.freedesktop.portal.ScreenCast D-Bus interface to request
//! screen sharing permission, then reads frames from a PipeWire stream.
//!
//! This implementation shells out to `pw-cat`/`gst-launch` as a pragmatic
//! approach that avoids requiring PipeWire C headers at build time while
//! still providing native Wayland capture. A future version could use
//! the `pipewire` crate directly.

use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use tracing::{debug, info, warn};

use agent_platform::screen::{ScreenCapture, ScreenFrame};
use std::io::Read;
use std::process::{Child, Command, Stdio};

/// Wayland screen capture using xdg-desktop-portal + GStreamer pipeline.
///
/// Flow:
/// 1. Use `gdbus` to call xdg-desktop-portal ScreenCast methods
/// 2. Get PipeWire node ID from the portal
/// 3. Use GStreamer (`gst-launch-1.0`) to read PipeWire and output raw frames
pub struct WaylandScreenCapture {
    width: u32,
    height: u32,
    gst_child: Option<Child>,
    pipewire_node: Option<u32>,
}

impl WaylandScreenCapture {
    pub fn new() -> Self {
        Self {
            width: 0,
            height: 0,
            gst_child: None,
            pipewire_node: None,
        }
    }

    /// Request screen sharing via xdg-desktop-portal using gdbus.
    /// Returns the PipeWire node ID.
    fn request_screencast_portal() -> Result<u32> {
        // Create a session
        let output = Command::new("gdbus")
            .args([
                "call",
                "--session",
                "--dest", "org.freedesktop.portal.Desktop",
                "--object-path", "/org/freedesktop/portal/desktop",
                "--method", "org.freedesktop.portal.ScreenCast.CreateSession",
                "{}",
            ])
            .output()
            .context("failed to call CreateSession — is xdg-desktop-portal running?")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            bail!("CreateSession failed: {}", stderr);
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        debug!("CreateSession response: {}", stdout);

        // Extract session handle from response
        let session_handle = extract_session_handle(&stdout)
            .context("failed to parse session handle from CreateSession response")?;

        info!("portal session created: {}", session_handle);

        // SelectSources — request monitor capture
        let output = Command::new("gdbus")
            .args([
                "call",
                "--session",
                "--dest", "org.freedesktop.portal.Desktop",
                "--object-path", "/org/freedesktop/portal/desktop",
                "--method", "org.freedesktop.portal.ScreenCast.SelectSources",
                &session_handle,
                "{'types': <uint32 1>, 'multiple': <false>}",
            ])
            .output()
            .context("failed to call SelectSources")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            bail!("SelectSources failed: {}", stderr);
        }

        // Start — this may show a user dialog on some compositors
        let output = Command::new("gdbus")
            .args([
                "call",
                "--session",
                "--dest", "org.freedesktop.portal.Desktop",
                "--object-path", "/org/freedesktop/portal/desktop",
                "--method", "org.freedesktop.portal.ScreenCast.Start",
                &session_handle,
                "",
                "{}",
            ])
            .output()
            .context("failed to call Start")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            bail!("Start failed: {}", stderr);
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        debug!("Start response: {}", stdout);

        // Extract PipeWire node ID from the Start response
        let node_id = extract_pipewire_node(&stdout)
            .context("failed to extract PipeWire node ID from Start response")?;

        info!("PipeWire node ID: {}", node_id);
        Ok(node_id)
    }

    /// Start a GStreamer pipeline that reads from PipeWire and outputs raw BGRA frames.
    fn start_gstreamer_pipeline(&mut self, node_id: u32) -> Result<(u32, u32)> {
        // First, probe the stream to get dimensions using gst-launch in info mode
        let probe_output = Command::new("gst-launch-1.0")
            .args([
                "--quiet",
                &format!("pipewiresrc path={}", node_id),
                "!",
                "videoconvert",
                "!",
                "video/x-raw,format=BGRx",
                "!",
                "fakesink",
                "-v",
            ])
            .stderr(Stdio::piped())
            .stdout(Stdio::null())
            .output();

        // If probe fails, use a default resolution and detect from first frame
        let (width, height) = match probe_output {
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                parse_gst_resolution(&stderr).unwrap_or((1920, 1080))
            }
            Err(_) => (1920, 1080),
        };

        info!(
            "starting GStreamer pipeline: PipeWire node {} -> {}x{} BGRA",
            node_id, width, height
        );

        // Start the actual capture pipeline
        // Output raw BGRA frames to stdout, one frame per `fdsink`
        let child = Command::new("gst-launch-1.0")
            .args([
                "--quiet",
                &format!("pipewiresrc path={}", node_id),
                "!",
                "videoconvert",
                "!",
                &format!("video/x-raw,format=BGRx,width={},height={}", width, height),
                "!",
                "fdsink",
                "fd=1",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .context("failed to start gst-launch-1.0 — is gstreamer1.0-tools installed?")?;

        self.gst_child = Some(child);
        self.width = width;
        self.height = height;

        Ok((width, height))
    }
}

#[async_trait]
impl ScreenCapture for WaylandScreenCapture {
    async fn init(&mut self) -> Result<(u32, u32)> {
        // Request screen sharing permission via portal
        let node_id = Self::request_screencast_portal()?;
        self.pipewire_node = Some(node_id);

        // Start GStreamer capture pipeline
        let dims = self.start_gstreamer_pipeline(node_id)?;
        Ok(dims)
    }

    async fn capture_frame(&mut self) -> Result<ScreenFrame> {
        let child = self
            .gst_child
            .as_mut()
            .context("GStreamer pipeline not started")?;

        let stdout = child
            .stdout
            .as_mut()
            .context("GStreamer stdout not available")?;

        // Each frame is width * height * 4 bytes (BGRx)
        let frame_size = (self.width * self.height * 4) as usize;
        let mut data = vec![0u8; frame_size];
        stdout
            .read_exact(&mut data)
            .context("failed to read frame from GStreamer pipeline")?;

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

impl Drop for WaylandScreenCapture {
    fn drop(&mut self) {
        if let Some(mut child) = self.gst_child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Extract the session handle from a gdbus CreateSession response.
/// Response format: `('/org/freedesktop/portal/desktop/session/...',)`
fn extract_session_handle(response: &str) -> Option<String> {
    // Look for a path-like string in parentheses
    let start = response.find("'/")? + 1;
    let end = response[start..].find('\'')? + start;
    Some(response[start..end].to_string())
}

/// Extract PipeWire node ID from a gdbus Start response.
/// The node ID appears in the streams array as a uint32.
fn extract_pipewire_node(response: &str) -> Option<u32> {
    // Look for "uint32 NNNN" pattern in the response
    for part in response.split("uint32 ") {
        if let Some(end) = part.find(|c: char| !c.is_ascii_digit()) {
            if let Ok(id) = part[..end].parse::<u32>() {
                if id > 0 {
                    return Some(id);
                }
            }
        }
    }
    None
}

/// Parse resolution from GStreamer verbose output.
fn parse_gst_resolution(output: &str) -> Option<(u32, u32)> {
    // Look for "width=(int)NNNN, height=(int)NNNN" in caps
    let width_start = output.find("width=(int)")? + "width=(int)".len();
    let width_end = output[width_start..].find(|c: char| !c.is_ascii_digit())? + width_start;
    let width: u32 = output[width_start..width_end].parse().ok()?;

    let height_start = output.find("height=(int)")? + "height=(int)".len();
    let height_end = output[height_start..].find(|c: char| !c.is_ascii_digit())? + height_start;
    let height: u32 = output[height_start..height_end].parse().ok()?;

    Some((width, height))
}
