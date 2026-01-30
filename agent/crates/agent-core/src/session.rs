use std::collections::HashMap;
use anyhow::{Context, Result};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use agent_platform::terminal::Terminal;
use crate::connection::ConnectionHandle;
use crate::desktop::{self, DesktopConfig};
use crate::protocol::{self, Message};

/// Manages active sessions (terminal, desktop, file) on different channels
pub struct SessionManager {
    terminal_sessions: HashMap<u16, TerminalSession>,
    desktop_sessions: HashMap<u16, DesktopSession>,
    handle: ConnectionHandle,
}

struct TerminalSession {
    /// Sender to forward stdin data to the terminal task
    stdin_tx: mpsc::Sender<Vec<u8>>,
    /// Sender to signal resize
    resize_tx: mpsc::Sender<(u16, u16)>,
    /// Handle to the spawned task
    _task: tokio::task::JoinHandle<()>,
}

struct DesktopSession {
    /// Sender to forward input events to the desktop task
    input_tx: mpsc::Sender<Vec<u8>>,
    /// Sender to forward quality changes
    quality_tx: mpsc::Sender<DesktopConfig>,
    /// Handle to the spawned task
    _task: tokio::task::JoinHandle<()>,
}

impl SessionManager {
    pub fn new(handle: ConnectionHandle) -> Self {
        Self {
            terminal_sessions: HashMap::new(),
            desktop_sessions: HashMap::new(),
            handle,
        }
    }

    /// Handle an incoming message from the server for session management
    pub async fn handle_message(&mut self, msg: Message) -> Result<()> {
        match msg.header.msg_type {
            protocol::TERMINAL_OPEN => {
                self.open_terminal(msg).await?;
            }
            protocol::TERMINAL_CLOSE => {
                self.close_terminal(msg.header.channel);
            }
            protocol::TERMINAL_DATA => {
                self.terminal_stdin(msg.header.channel, msg.payload).await;
            }
            protocol::TERMINAL_RESIZE => {
                self.terminal_resize(msg).await;
            }
            protocol::DESKTOP_OPEN => {
                self.open_desktop(msg).await?;
            }
            protocol::DESKTOP_CLOSE => {
                self.close_desktop(msg.header.channel);
            }
            protocol::DESKTOP_INPUT => {
                self.desktop_input(msg.header.channel, msg.payload).await;
            }
            protocol::DESKTOP_QUALITY => {
                self.desktop_quality(msg).await;
            }
            _ => {
                warn!("session manager: unhandled message type 0x{:02x}", msg.header.msg_type);
            }
        }
        Ok(())
    }

    async fn open_terminal(&mut self, msg: Message) -> Result<()> {
        let channel = msg.header.channel;

        if self.terminal_sessions.contains_key(&channel) {
            warn!("terminal already exists on channel {}, closing old one", channel);
            self.close_terminal(channel);
        }

        let req: protocol::TerminalOpenRequest = msg.parse_json()
            .context("failed to parse TERMINAL_OPEN")?;

        info!(
            "opening terminal on channel {}: shell={:?}, cols={}, rows={}",
            channel, req.shell, req.cols, req.rows
        );

        let (stdin_tx, stdin_rx) = mpsc::channel::<Vec<u8>>(256);
        let (resize_tx, resize_rx) = mpsc::channel::<(u16, u16)>(16);
        let handle = self.handle.clone();

        let shell = req.shell.clone();
        let cols = req.cols;
        let rows = req.rows;

        let task = tokio::spawn(async move {
            if let Err(e) = run_terminal_session(
                channel, shell, cols, rows, stdin_rx, resize_rx, handle,
            ).await {
                error!("terminal session on channel {} ended with error: {:#}", channel, e);
            }
        });

        self.terminal_sessions.insert(channel, TerminalSession {
            stdin_tx,
            resize_tx,
            _task: task,
        });

        Ok(())
    }

    fn close_terminal(&mut self, channel: u16) {
        if let Some(session) = self.terminal_sessions.remove(&channel) {
            info!("closing terminal on channel {}", channel);
            // Dropping stdin_tx and resize_tx will cause the task to exit
            drop(session.stdin_tx);
            drop(session.resize_tx);
            // Task will clean up the PTY on drop
        }
    }

    async fn terminal_stdin(&mut self, channel: u16, data: Vec<u8>) {
        if let Some(session) = self.terminal_sessions.get(&channel) {
            if session.stdin_tx.send(data).await.is_err() {
                warn!("terminal stdin channel {} closed, removing session", channel);
                self.terminal_sessions.remove(&channel);
            }
        } else {
            debug!("terminal data for unknown channel {}", channel);
        }
    }

    async fn terminal_resize(&mut self, msg: Message) {
        let channel = msg.header.channel;
        if msg.payload.len() < 4 {
            warn!("terminal resize payload too short");
            return;
        }

        let cols = u16::from_le_bytes([msg.payload[0], msg.payload[1]]);
        let rows = u16::from_le_bytes([msg.payload[2], msg.payload[3]]);

        if let Some(session) = self.terminal_sessions.get(&channel) {
            let _ = session.resize_tx.send((cols, rows)).await;
        }
    }

    // --- Desktop session management ---

    async fn open_desktop(&mut self, msg: Message) -> Result<()> {
        let channel = msg.header.channel;

        if self.desktop_sessions.contains_key(&channel) {
            warn!("desktop already exists on channel {}, closing old one", channel);
            self.close_desktop(channel);
        }

        let req: protocol::DesktopOpenRequest = msg.parse_json()
            .context("failed to parse DESKTOP_OPEN")?;

        info!(
            "opening desktop on channel {}: quality={}, fps={}, encoding={}",
            channel, req.quality, req.fps, req.encoding
        );

        let config = DesktopConfig {
            quality: req.quality,
            fps: req.fps,
            encoding: req.encoding,
        };

        let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(256);
        let (quality_tx, mut quality_rx) = mpsc::channel::<DesktopConfig>(8);
        let handle = self.handle.clone();

        let task = tokio::spawn(async move {
            // Create platform screen capture and input injector
            let screen = match create_platform_screen() {
                Ok(s) => s,
                Err(e) => {
                    error!("failed to create screen capture: {:#}", e);
                    return;
                }
            };

            let mut injector = match create_platform_input() {
                Ok(i) => i,
                Err(e) => {
                    error!("failed to create input injector: {:#}", e);
                    return;
                }
            };

            // Spawn the capture loop in a separate task
            let capture_handle = handle.clone();
            let capture_task = tokio::spawn(async move {
                if let Err(e) = desktop::run_desktop_session(channel, config, screen, capture_handle).await {
                    error!("desktop capture on channel {} ended with error: {:#}", channel, e);
                }
            });

            // Process input events and quality changes
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
                                // Quality changes are handled by restarting the session
                                // For now, log the change
                                info!("desktop quality change requested on channel {}", channel);
                            }
                            None => break,
                        }
                    }
                }
            }

            capture_task.abort();
            info!("desktop session ended on channel {}", channel);
        });

        self.desktop_sessions.insert(channel, DesktopSession {
            input_tx,
            quality_tx,
            _task: task,
        });

        Ok(())
    }

    fn close_desktop(&mut self, channel: u16) {
        if let Some(session) = self.desktop_sessions.remove(&channel) {
            info!("closing desktop on channel {}", channel);
            drop(session.input_tx);
            drop(session.quality_tx);
        }
    }

    async fn desktop_input(&mut self, channel: u16, data: Vec<u8>) {
        if let Some(session) = self.desktop_sessions.get(&channel) {
            if session.input_tx.send(data).await.is_err() {
                warn!("desktop input channel {} closed, removing session", channel);
                self.desktop_sessions.remove(&channel);
            }
        } else {
            debug!("desktop input for unknown channel {}", channel);
        }
    }

    async fn desktop_quality(&mut self, msg: Message) {
        let channel = msg.header.channel;
        if let Ok(req) = msg.parse_json::<protocol::DesktopOpenRequest>() {
            let config = DesktopConfig {
                quality: req.quality,
                fps: req.fps,
                encoding: req.encoding,
            };
            if let Some(session) = self.desktop_sessions.get(&channel) {
                let _ = session.quality_tx.send(config).await;
            }
        }
    }

    /// Check if any sessions are active
    pub fn has_active_sessions(&self) -> bool {
        !self.terminal_sessions.is_empty() || !self.desktop_sessions.is_empty()
    }

    /// Close all sessions
    pub fn close_all(&mut self) {
        let terminal_channels: Vec<u16> = self.terminal_sessions.keys().copied().collect();
        for channel in terminal_channels {
            self.close_terminal(channel);
        }
        let desktop_channels: Vec<u16> = self.desktop_sessions.keys().copied().collect();
        for channel in desktop_channels {
            self.close_desktop(channel);
        }
    }
}

/// Run a single terminal session — spawns PTY and relays data
async fn run_terminal_session(
    channel: u16,
    shell: Option<String>,
    cols: u16,
    rows: u16,
    mut stdin_rx: mpsc::Receiver<Vec<u8>>,
    mut resize_rx: mpsc::Receiver<(u16, u16)>,
    handle: ConnectionHandle,
) -> Result<()> {
    let mut terminal = create_platform_terminal()?;

    terminal
        .spawn(shell.as_deref(), cols, rows)
        .await
        .context("failed to spawn terminal")?;

    info!("terminal session started on channel {}", channel);

    loop {
        tokio::select! {
            // Read stdout from terminal -> send to server
            result = terminal.read_stdout() => {
                match result {
                    Ok(data) if data.is_empty() => {
                        // No data available (false readiness), continue
                        continue;
                    }
                    Ok(data) => {
                        let msg = protocol::terminal_data(channel, data);
                        if let Err(e) = handle.send_message(&msg).await {
                            error!("failed to send terminal data: {}", e);
                            break;
                        }
                    }
                    Err(e) => {
                        info!("terminal stdout ended on channel {}: {}", channel, e);
                        break;
                    }
                }
            }

            // Receive stdin from server -> write to terminal
            data = stdin_rx.recv() => {
                match data {
                    Some(data) => {
                        if let Err(e) = terminal.write_stdin(&data).await {
                            error!("failed to write terminal stdin: {}", e);
                            break;
                        }
                    }
                    None => {
                        info!("terminal stdin channel closed on channel {}", channel);
                        break;
                    }
                }
            }

            // Handle resize requests
            resize = resize_rx.recv() => {
                match resize {
                    Some((cols, rows)) => {
                        if let Err(e) = terminal.resize(cols, rows).await {
                            warn!("terminal resize failed: {}", e);
                        }
                    }
                    None => {
                        // Resize channel closed, not critical
                    }
                }
            }
        }

        // Check if terminal process is still alive
        if !terminal.is_alive() {
            info!("terminal process exited on channel {}", channel);
            break;
        }
    }

    // Send TERMINAL_CLOSE to server
    let close_msg = Message::session(protocol::TERMINAL_CLOSE, channel, 0, vec![]);
    let _ = handle.send_message(&close_msg).await;

    info!("terminal session ended on channel {}", channel);
    Ok(())
}

// --- Platform screen capture and input creation ---

#[cfg(target_os = "linux")]
fn create_platform_screen() -> Result<Box<dyn agent_platform::screen::ScreenCapture>> {
    agent_linux::screen::create_screen_capture()
}

#[cfg(target_os = "linux")]
fn create_platform_input() -> Result<Box<dyn agent_platform::input::InputInjector>> {
    agent_linux::input::create_input_injector()
}

#[cfg(target_os = "macos")]
fn create_platform_screen() -> Result<Box<dyn agent_platform::screen::ScreenCapture>> {
    anyhow::bail!("screen capture not yet implemented for macOS")
}

#[cfg(target_os = "macos")]
fn create_platform_input() -> Result<Box<dyn agent_platform::input::InputInjector>> {
    anyhow::bail!("input injection not yet implemented for macOS")
}

#[cfg(target_os = "windows")]
fn create_platform_screen() -> Result<Box<dyn agent_platform::screen::ScreenCapture>> {
    agent_windows::screen::create_screen_capture()
}

#[cfg(target_os = "windows")]
fn create_platform_input() -> Result<Box<dyn agent_platform::input::InputInjector>> {
    agent_windows::input::create_input_injector()
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn create_platform_screen() -> Result<Box<dyn agent_platform::screen::ScreenCapture>> {
    anyhow::bail!("screen capture not supported on this platform")
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn create_platform_input() -> Result<Box<dyn agent_platform::input::InputInjector>> {
    anyhow::bail!("input injection not supported on this platform")
}

/// Create the platform-appropriate terminal implementation
#[cfg(target_os = "linux")]
fn create_platform_terminal() -> Result<Box<dyn Terminal>> {
    Ok(Box::new(agent_linux::terminal::LinuxTerminal::new()))
}

#[cfg(target_os = "macos")]
fn create_platform_terminal() -> Result<Box<dyn Terminal>> {
    anyhow::bail!("terminal not yet implemented for macOS")
}

#[cfg(target_os = "windows")]
fn create_platform_terminal() -> Result<Box<dyn Terminal>> {
    Ok(Box::new(agent_windows::terminal::WindowsTerminal::new()))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn create_platform_terminal() -> Result<Box<dyn Terminal>> {
    anyhow::bail!("terminal not supported on this platform")
}
