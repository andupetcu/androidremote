// Helper process mode — runs in the user's interactive session.
//
// Spawned by the service process (Session 0) via CreateProcessAsUser.
// Connects back to the service via a named pipe and handles:
// - Screen capture (DXGI → GDI fallback)
// - Input injection (SendInput)
// - Terminal sessions (ConPTY)

use std::collections::HashMap;

use anyhow::{Context, Result};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use agent_core::protocol::{self, Message};
use agent_core::desktop::{self, DesktopConfig};
use agent_platform::terminal::Terminal;

#[cfg(target_os = "windows")]
use agent_windows::ipc::{IpcClient, IpcWriter};

struct HelperTerminalSession {
    stdin_tx: mpsc::Sender<Vec<u8>>,
    resize_tx: mpsc::Sender<(u16, u16)>,
    _task: tokio::task::JoinHandle<()>,
}

struct HelperDesktopSession {
    input_tx: mpsc::Sender<Vec<u8>>,
    quality_tx: mpsc::Sender<DesktopConfig>,
    _capture_task: tokio::task::JoinHandle<()>,
    _input_task: tokio::task::JoinHandle<()>,
}

/// Run the helper process. Connects to the service pipe and processes messages.
#[cfg(target_os = "windows")]
pub async fn run_helper_mode(pipe_name: &str) -> Result<()> {
    info!("helper mode starting, connecting to pipe: {}", pipe_name);

    // Retry connection a few times — the service may still be setting up the pipe
    let client = retry_connect(pipe_name, 10, std::time::Duration::from_millis(500)).await?;

    let (reader, writer) = client.split();

    // Wrap writer in Arc for sharing across tasks
    let writer = std::sync::Arc::new(tokio::sync::Mutex::new(writer));

    let mut terminal_sessions: HashMap<u16, HelperTerminalSession> = HashMap::new();
    let mut desktop_sessions: HashMap<u16, HelperDesktopSession> = HashMap::new();

    // Use a Mutex<IpcReader> so we own it properly in the loop
    let mut reader = reader;

    info!("helper connected, entering message loop");

    loop {
        let raw = match reader.recv_raw().await {
            Ok(data) => data,
            Err(e) => {
                info!("pipe disconnected, helper shutting down: {}", e);
                break;
            }
        };

        // Decode the protocol message
        let (msg, _consumed) = match Message::decode(&raw) {
            Ok(Some(m)) => m,
            Ok(None) => {
                warn!("incomplete message received from pipe");
                continue;
            }
            Err(e) => {
                warn!("failed to decode message from pipe: {}", e);
                continue;
            }
        };

        match msg.header.msg_type {
            // --- Desktop ---
            protocol::DESKTOP_OPEN => {
                let channel = msg.header.channel;
                if desktop_sessions.contains_key(&channel) {
                    info!("desktop already open on channel {}, closing old", channel);
                    desktop_sessions.remove(&channel);
                }

                let req: protocol::DesktopOpenRequest = match msg.parse_json() {
                    Ok(r) => r,
                    Err(e) => {
                        error!("failed to parse DESKTOP_OPEN: {}", e);
                        continue;
                    }
                };

                info!(
                    "helper: opening desktop on channel {} (quality={}, fps={})",
                    channel, req.quality, req.fps
                );

                let config = DesktopConfig {
                    quality: req.quality,
                    fps: req.fps,
                    encoding: req.encoding,
                };

                let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(256);
                let (quality_tx, mut quality_rx) = mpsc::channel::<DesktopConfig>(8);

                // Capture task — sends frames back through the pipe
                let writer_clone = writer.clone();
                let capture_task = tokio::spawn(async move {
                    if let Err(e) = run_helper_desktop_capture(channel, config, writer_clone).await {
                        error!("helper desktop capture error on channel {}: {:#}", channel, e);
                    }
                });

                // Input task — processes input events from the pipe
                let input_task = tokio::spawn(async move {
                    let mut injector = match create_platform_input() {
                        Ok(i) => i,
                        Err(e) => {
                            error!("failed to create input injector: {:#}", e);
                            return;
                        }
                    };

                    loop {
                        tokio::select! {
                            input = input_rx.recv() => {
                                match input {
                                    Some(data) => {
                                        if let Err(e) = desktop::handle_desktop_input(&data, injector.as_mut()) {
                                            warn!("desktop input error: {:#}", e);
                                        }
                                    }
                                    None => break,
                                }
                            }
                            quality = quality_rx.recv() => {
                                match quality {
                                    Some(_new_config) => {
                                        info!("desktop quality change on channel {}", channel);
                                    }
                                    None => break,
                                }
                            }
                        }
                    }
                });

                desktop_sessions.insert(channel, HelperDesktopSession {
                    input_tx,
                    quality_tx,
                    _capture_task: capture_task,
                    _input_task: input_task,
                });
            }

            protocol::DESKTOP_CLOSE => {
                let channel = msg.header.channel;
                if desktop_sessions.remove(&channel).is_some() {
                    info!("helper: closed desktop on channel {}", channel);
                }
            }

            protocol::DESKTOP_INPUT => {
                let channel = msg.header.channel;
                if let Some(session) = desktop_sessions.get(&channel) {
                    let _ = session.input_tx.send(msg.payload).await;
                }
            }

            protocol::DESKTOP_QUALITY => {
                let channel = msg.header.channel;
                if let Ok(req) = msg.parse_json::<protocol::DesktopOpenRequest>() {
                    let config = DesktopConfig {
                        quality: req.quality,
                        fps: req.fps,
                        encoding: req.encoding,
                    };
                    if let Some(session) = desktop_sessions.get(&channel) {
                        let _ = session.quality_tx.send(config).await;
                    }
                }
            }

            // --- Terminal ---
            protocol::TERMINAL_OPEN => {
                let channel = msg.header.channel;
                if terminal_sessions.contains_key(&channel) {
                    info!("terminal already open on channel {}, closing old", channel);
                    terminal_sessions.remove(&channel);
                }

                let req: protocol::TerminalOpenRequest = match msg.parse_json() {
                    Ok(r) => r,
                    Err(e) => {
                        error!("failed to parse TERMINAL_OPEN: {}", e);
                        continue;
                    }
                };

                info!(
                    "helper: opening terminal on channel {} (shell={:?}, cols={}, rows={})",
                    channel, req.shell, req.cols, req.rows
                );

                let (stdin_tx, stdin_rx) = mpsc::channel::<Vec<u8>>(256);
                let (resize_tx, resize_rx) = mpsc::channel::<(u16, u16)>(16);
                let writer_clone = writer.clone();

                let shell = req.shell;
                let cols = req.cols;
                let rows = req.rows;

                let task = tokio::spawn(async move {
                    if let Err(e) = run_helper_terminal(
                        channel, shell, cols, rows, stdin_rx, resize_rx, writer_clone,
                    ).await {
                        error!("helper terminal session on channel {} error: {:#}", channel, e);
                    }
                });

                terminal_sessions.insert(channel, HelperTerminalSession {
                    stdin_tx,
                    resize_tx,
                    _task: task,
                });
            }

            protocol::TERMINAL_CLOSE => {
                let channel = msg.header.channel;
                if terminal_sessions.remove(&channel).is_some() {
                    info!("helper: closed terminal on channel {}", channel);
                }
            }

            protocol::TERMINAL_DATA => {
                let channel = msg.header.channel;
                if let Some(session) = terminal_sessions.get(&channel) {
                    let _ = session.stdin_tx.send(msg.payload).await;
                }
            }

            protocol::TERMINAL_RESIZE => {
                let channel = msg.header.channel;
                if msg.payload.len() >= 4 {
                    let cols = u16::from_le_bytes([msg.payload[0], msg.payload[1]]);
                    let rows = u16::from_le_bytes([msg.payload[2], msg.payload[3]]);
                    if let Some(session) = terminal_sessions.get(&channel) {
                        let _ = session.resize_tx.send((cols, rows)).await;
                    }
                }
            }

            other => {
                debug!("helper: ignoring message type 0x{:02x}", other);
            }
        }
    }

    // Cleanup
    terminal_sessions.clear();
    desktop_sessions.clear();
    info!("helper mode exiting");
    Ok(())
}

/// Run desktop capture in the helper, sending frames back through the IPC pipe.
#[cfg(target_os = "windows")]
async fn run_helper_desktop_capture(
    channel: u16,
    config: DesktopConfig,
    writer: std::sync::Arc<tokio::sync::Mutex<IpcWriter>>,
) -> Result<()> {
    let mut screen = create_platform_screen()?;

    let (width, height) = screen.init().await
        .context("failed to initialize screen capture")?;

    let mut encoder = desktop::TileEncoder::new(width, height, config.quality);

    let frame_interval = std::time::Duration::from_millis(1000 / config.fps.max(1) as u64);

    // Send initial DESKTOP_RESIZE
    {
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
        let encoded = resize_msg.encode();
        writer.lock().await.send_raw(&encoded).await?;
    }

    info!(
        "helper desktop capture started on channel {} ({}x{}, {}fps)",
        channel, width, height, config.fps
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
                desktop::ENCODING_JPEG,
                tile.flags,
                tile.data,
            );
            let encoded = msg.encode();
            if let Err(e) = writer.lock().await.send_raw(&encoded).await {
                debug!("failed to send desktop frame through pipe: {}", e);
                return Ok(());
            }
        }
    }
}

/// Run a terminal session in the helper, relaying data through the IPC pipe.
#[cfg(target_os = "windows")]
async fn run_helper_terminal(
    channel: u16,
    shell: Option<String>,
    cols: u16,
    rows: u16,
    mut stdin_rx: mpsc::Receiver<Vec<u8>>,
    mut resize_rx: mpsc::Receiver<(u16, u16)>,
    writer: std::sync::Arc<tokio::sync::Mutex<IpcWriter>>,
) -> Result<()> {
    let mut terminal = create_platform_terminal()?;

    terminal
        .spawn(shell.as_deref(), cols, rows)
        .await
        .context("failed to spawn terminal")?;

    info!("helper terminal session started on channel {}", channel);

    loop {
        tokio::select! {
            result = terminal.read_stdout() => {
                match result {
                    Ok(data) if data.is_empty() => continue,
                    Ok(data) => {
                        let msg = protocol::terminal_data(channel, data);
                        let encoded = msg.encode();
                        if let Err(e) = writer.lock().await.send_raw(&encoded).await {
                            error!("failed to send terminal data through pipe: {}", e);
                            break;
                        }
                    }
                    Err(e) => {
                        info!("terminal stdout ended on channel {}: {}", channel, e);
                        break;
                    }
                }
            }

            data = stdin_rx.recv() => {
                match data {
                    Some(data) => {
                        if let Err(e) = terminal.write_stdin(&data).await {
                            error!("failed to write terminal stdin: {}", e);
                            break;
                        }
                    }
                    None => {
                        info!("terminal stdin closed on channel {}", channel);
                        break;
                    }
                }
            }

            resize = resize_rx.recv() => {
                match resize {
                    Some((cols, rows)) => {
                        if let Err(e) = terminal.resize(cols, rows).await {
                            warn!("terminal resize failed: {}", e);
                        }
                    }
                    None => {}
                }
            }
        }

        if !terminal.is_alive() {
            info!("terminal process exited on channel {}", channel);
            break;
        }
    }

    // Send TERMINAL_CLOSE back through pipe
    let close_msg = Message::session(protocol::TERMINAL_CLOSE, channel, 0, vec![]);
    let encoded = close_msg.encode();
    let _ = writer.lock().await.send_raw(&encoded).await;

    info!("helper terminal session ended on channel {}", channel);
    Ok(())
}

/// Retry connecting to the named pipe with backoff.
#[cfg(target_os = "windows")]
async fn retry_connect(
    pipe_name: &str,
    max_retries: u32,
    delay: std::time::Duration,
) -> Result<IpcClient> {
    for attempt in 1..=max_retries {
        match IpcClient::connect(pipe_name) {
            Ok(client) => return Ok(client),
            Err(e) => {
                if attempt == max_retries {
                    return Err(e).context("failed to connect to service pipe after retries");
                }
                info!(
                    "pipe connection attempt {}/{} failed: {}, retrying...",
                    attempt, max_retries, e
                );
                tokio::time::sleep(delay).await;
            }
        }
    }
    unreachable!()
}

// --- Platform factories (same as session.rs but local to helper) ---

#[cfg(target_os = "windows")]
fn create_platform_screen() -> Result<Box<dyn agent_platform::screen::ScreenCapture>> {
    agent_windows::screen::create_screen_capture()
}

#[cfg(target_os = "windows")]
fn create_platform_input() -> Result<Box<dyn agent_platform::input::InputInjector>> {
    agent_windows::input::create_input_injector()
}

#[cfg(target_os = "windows")]
fn create_platform_terminal() -> Result<Box<dyn Terminal>> {
    Ok(Box::new(agent_windows::terminal::WindowsTerminal::new()))
}
