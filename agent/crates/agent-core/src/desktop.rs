//! Desktop session — tile-based screen capture, diff, and JPEG encoding.

use anyhow::{Context, Result};
use tracing::{debug, info, warn};

use agent_platform::input::InputInjector;
use agent_platform::screen::ScreenCapture;

use crate::connection::ConnectionHandle;
use crate::protocol;

/// Tile size in pixels (64x64)
pub const TILE_SIZE: u32 = 64;

/// Encoding types for DESKTOP_FRAME
pub const ENCODING_JPEG: u8 = 0;
pub const ENCODING_PNG: u8 = 1;
pub const ENCODING_RAW: u8 = 2;

/// Frame flags
pub const FLAG_KEYFRAME: u8 = 0x01;

/// Desktop session configuration
#[derive(Debug, Clone)]
pub struct DesktopConfig {
    pub quality: u8,
    pub fps: u16,
    pub encoding: String,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self {
            quality: 70,
            fps: 15,
            encoding: "jpeg".to_string(),
        }
    }
}

/// Tile-based screen differ and encoder
pub struct TileEncoder {
    width: u32,
    height: u32,
    /// Number of tiles in X direction
    tiles_x: u32,
    /// Number of tiles in Y direction
    tiles_y: u32,
    /// Previous frame data for diffing (BGRA)
    prev_frame: Vec<u8>,
    /// JPEG quality (1-100)
    quality: u8,
    /// Whether the next frame should be a keyframe (all tiles sent)
    force_keyframe: bool,
}

impl TileEncoder {
    pub fn new(width: u32, height: u32, quality: u8) -> Self {
        let tiles_x = (width + TILE_SIZE - 1) / TILE_SIZE;
        let tiles_y = (height + TILE_SIZE - 1) / TILE_SIZE;

        info!(
            "tile encoder: {}x{} screen, {}x{} tiles ({} total), quality={}",
            width, height, tiles_x, tiles_y, tiles_x * tiles_y, quality
        );

        Self {
            width,
            height,
            tiles_x,
            tiles_y,
            prev_frame: Vec::new(),
            quality,
            force_keyframe: true, // first frame is always a keyframe
        }
    }

    pub fn set_quality(&mut self, quality: u8) {
        self.quality = quality.clamp(1, 100);
    }

    pub fn request_keyframe(&mut self) {
        self.force_keyframe = true;
    }

    /// Encode changed tiles from a BGRA frame.
    /// Returns a list of (tile_x, tile_y, tile_w, tile_h, jpeg_data, flags) tuples.
    pub fn encode_frame(
        &mut self,
        frame_data: &[u8],
        stride: u32,
    ) -> Result<Vec<TileData>> {
        let is_keyframe = self.force_keyframe || self.prev_frame.is_empty();
        if is_keyframe {
            self.force_keyframe = false;
        }

        let mut tiles = Vec::new();

        for ty in 0..self.tiles_y {
            for tx in 0..self.tiles_x {
                let pixel_x = tx * TILE_SIZE;
                let pixel_y = ty * TILE_SIZE;
                let tile_w = (self.width - pixel_x).min(TILE_SIZE);
                let tile_h = (self.height - pixel_y).min(TILE_SIZE);

                // Check if tile changed
                if !is_keyframe && !self.prev_frame.is_empty() {
                    if !self.tile_changed(frame_data, stride, pixel_x, pixel_y, tile_w, tile_h) {
                        continue;
                    }
                }

                // Extract tile pixels as RGB (convert from BGRA)
                let rgb = self.extract_tile_rgb(frame_data, stride, pixel_x, pixel_y, tile_w, tile_h);

                // Encode as JPEG using turbojpeg
                let jpeg_data = encode_jpeg_tile(&rgb, tile_w, tile_h, self.quality)?;

                let flags = if is_keyframe { FLAG_KEYFRAME } else { 0 };

                tiles.push(TileData {
                    x: pixel_x as u16,
                    y: pixel_y as u16,
                    w: tile_w as u16,
                    h: tile_h as u16,
                    data: jpeg_data,
                    flags,
                });
            }
        }

        // Store current frame for next comparison
        self.prev_frame = frame_data.to_vec();

        debug!(
            "encoded {} / {} tiles (keyframe={})",
            tiles.len(),
            self.tiles_x * self.tiles_y,
            is_keyframe
        );

        Ok(tiles)
    }

    fn tile_changed(
        &self,
        frame_data: &[u8],
        stride: u32,
        px: u32,
        py: u32,
        tw: u32,
        th: u32,
    ) -> bool {
        let prev_stride = self.width * 4;
        for row in 0..th {
            let y = py + row;
            let new_start = (y * stride + px * 4) as usize;
            let new_end = new_start + (tw * 4) as usize;
            let old_start = (y * prev_stride + px * 4) as usize;
            let old_end = old_start + (tw * 4) as usize;

            if new_end > frame_data.len() || old_end > self.prev_frame.len() {
                return true;
            }

            if frame_data[new_start..new_end] != self.prev_frame[old_start..old_end] {
                return true;
            }
        }
        false
    }

    fn extract_tile_rgb(
        &self,
        frame_data: &[u8],
        stride: u32,
        px: u32,
        py: u32,
        tw: u32,
        th: u32,
    ) -> Vec<u8> {
        let mut rgb = Vec::with_capacity((tw * th * 3) as usize);

        for row in 0..th {
            let y = py + row;
            let row_start = (y * stride + px * 4) as usize;

            for col in 0..tw {
                let offset = row_start + (col * 4) as usize;
                if offset + 2 < frame_data.len() {
                    // BGRA -> RGB
                    rgb.push(frame_data[offset + 2]); // R
                    rgb.push(frame_data[offset + 1]); // G
                    rgb.push(frame_data[offset]);      // B
                } else {
                    rgb.extend_from_slice(&[0, 0, 0]);
                }
            }
        }

        rgb
    }
}

/// A single encoded tile
pub struct TileData {
    pub x: u16,
    pub y: u16,
    pub w: u16,
    pub h: u16,
    pub data: Vec<u8>,
    pub flags: u8,
}

/// Encode RGB pixels to JPEG using turbojpeg
fn encode_jpeg_tile(rgb: &[u8], width: u32, height: u32, quality: u8) -> Result<Vec<u8>> {
    let mut compressor = turbojpeg::Compressor::new()
        .context("failed to create JPEG compressor")?;
    let _ = compressor.set_quality(quality as i32);

    let image = turbojpeg::Image {
        pixels: rgb,
        width: width as usize,
        pitch: (width * 3) as usize,
        height: height as usize,
        format: turbojpeg::PixelFormat::RGB,
    };

    let jpeg = compressor.compress_to_vec(image)
        .context("JPEG compression failed")?;

    Ok(jpeg)
}

/// Parse a DESKTOP_INPUT message payload and dispatch to the input injector.
pub fn handle_desktop_input(
    payload: &[u8],
    injector: &mut dyn InputInjector,
) -> Result<()> {
    if payload.is_empty() {
        return Ok(());
    }

    let input_type = payload[0];
    let data = &payload[1..];

    match input_type {
        protocol::desktop_input::MOUSE_MOVE => {
            if data.len() >= 4 {
                let x = u16::from_le_bytes([data[0], data[1]]) as u32;
                let y = u16::from_le_bytes([data[2], data[3]]) as u32;
                injector.mouse_move(x, y)?;
            }
        }
        protocol::desktop_input::MOUSE_BUTTON => {
            if data.len() >= 2 {
                let btn = match data[0] {
                    0 => agent_platform::input::MouseButton::Left,
                    1 => agent_platform::input::MouseButton::Right,
                    2 => agent_platform::input::MouseButton::Middle,
                    _ => return Ok(()),
                };
                let action = match data[1] {
                    0 => agent_platform::input::ButtonAction::Press,
                    1 => agent_platform::input::ButtonAction::Release,
                    _ => return Ok(()),
                };
                injector.mouse_button(btn, action)?;
            }
        }
        protocol::desktop_input::MOUSE_SCROLL => {
            if data.len() >= 4 {
                let dx = i16::from_le_bytes([data[0], data[1]]) as i32;
                let dy = i16::from_le_bytes([data[2], data[3]]) as i32;
                injector.mouse_scroll(dx, dy)?;
            }
        }
        protocol::desktop_input::KEY_EVENT => {
            if data.len() >= 4 {
                let scancode = u16::from_le_bytes([data[0], data[1]]);
                let action = match data[2] {
                    0 => agent_platform::input::KeyAction::Press,
                    1 => agent_platform::input::KeyAction::Release,
                    _ => return Ok(()),
                };
                let mods = if data.len() >= 5 {
                    let m = data[3];
                    agent_platform::input::Modifiers {
                        shift: m & 0x01 != 0,
                        ctrl: m & 0x02 != 0,
                        alt: m & 0x04 != 0,
                        meta: m & 0x08 != 0,
                    }
                } else {
                    agent_platform::input::Modifiers::default()
                };
                injector.key_press(scancode, action, mods)?;
            }
        }
        protocol::desktop_input::TYPE_TEXT => {
            let text = std::str::from_utf8(data).unwrap_or("");
            if !text.is_empty() {
                injector.type_text(text)?;
            }
        }
        other => {
            warn!("unknown desktop input type: 0x{:02x}", other);
        }
    }

    Ok(())
}

/// Run the desktop capture loop — captures frames at the configured FPS,
/// encodes changed tiles, and sends them to the server.
pub async fn run_desktop_session(
    channel: u16,
    config: DesktopConfig,
    mut screen: Box<dyn ScreenCapture>,
    handle: ConnectionHandle,
) -> Result<()> {
    let (width, height) = screen.init().await
        .context("failed to initialize screen capture")?;

    let mut encoder = TileEncoder::new(width, height, config.quality);

    let frame_interval = std::time::Duration::from_millis(1000 / config.fps.max(1) as u64);

    // Send initial DESKTOP_RESIZE so the viewer knows dimensions
    let resize_msg = protocol::Message::session(
        protocol::DESKTOP_RESIZE,
        channel,
        0,
        {
            let mut p = Vec::with_capacity(4);
            use bytes::BufMut;
            p.put_u16_le(width as u16);
            p.put_u16_le(height as u16);
            p
        },
    );
    handle.send_message(&resize_msg).await?;

    info!(
        "desktop session started on channel {} ({}x{}, {}fps, quality {})",
        channel, width, height, config.fps, config.quality
    );

    let mut interval = tokio::time::interval(frame_interval);

    loop {
        interval.tick().await;

        let frame = match screen.capture_frame().await {
            Ok(f) => f,
            Err(e) => {
                warn!("screen capture failed: {:#}", e);
                continue;
            }
        };

        let tiles = match encoder.encode_frame(&frame.data, frame.stride) {
            Ok(t) => t,
            Err(e) => {
                warn!("frame encoding failed: {:#}", e);
                continue;
            }
        };

        for tile in tiles {
            let msg = protocol::desktop_frame(
                channel,
                tile.x,
                tile.y,
                tile.w,
                tile.h,
                ENCODING_JPEG,
                tile.flags,
                tile.data,
            );
            if let Err(e) = handle.send_message(&msg).await {
                debug!("failed to send desktop frame: {}", e);
                return Ok(());
            }
        }
    }
}
