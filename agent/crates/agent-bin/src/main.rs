use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use tokio::sync::mpsc;
use tracing::{error, info, warn};

use agent_core::auto_update;
use agent_core::config::AgentConfig;
use agent_core::connection::{self, ConnectionHandle, ServerEvent};
use agent_core::files::FileHandler;
use agent_core::protocol;
use agent_core::session::SessionManager;
use agent_core::telemetry::TelemetryCollector;

#[cfg(target_os = "windows")]
mod helper;

mod install;

#[derive(Parser, Debug)]
#[command(name = "android-remote-agent")]
#[command(about = "Cross-platform remote management agent")]
#[command(version)]
struct Cli {
    /// Server URL (e.g., wss://server:7899 or ws://server:7899)
    #[arg(long, env = "AGENT_SERVER_URL", global = true)]
    server_url: Option<String>,

    /// Enrollment token for first-time registration
    #[arg(long, env = "AGENT_ENROLL_TOKEN", global = true)]
    enroll_token: Option<String>,

    /// Path to config file
    #[arg(long, env = "AGENT_CONFIG_PATH", global = true)]
    config_path: Option<String>,

    /// Run in foreground (don't daemonize)
    #[arg(long, default_value = "true")]
    foreground: bool,

    /// Log level (trace, debug, info, warn, error)
    #[arg(long, default_value = "info", env = "AGENT_LOG_LEVEL", global = true)]
    log_level: String,

    /// Run as helper process (spawned by service, not user-facing)
    #[arg(long, hide = true)]
    helper_mode: bool,

    /// Named pipe path for helper IPC (used with --helper-mode)
    #[arg(long, hide = true)]
    pipe_name: Option<String>,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Install the agent as a system service (silent/unattended)
    Install {
        /// Installation directory (default: platform-specific)
        #[arg(long)]
        install_dir: Option<String>,
    },
    /// Remove the agent service and optionally all files
    Uninstall {
        /// Also remove config files and installation directory
        #[arg(long)]
        purge: bool,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    // Initialize logging
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(&cli.log_level));

    tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_target(false)
        .init();

    info!(
        "android-remote-agent v{} starting (os={}, arch={})",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
    );

    // Dispatch subcommands
    match cli.command {
        Some(Commands::Install { install_dir }) => {
            return install::run_install(
                install_dir,
                cli.server_url,
                cli.enroll_token,
            )
            .await;
        }
        Some(Commands::Uninstall { purge }) => {
            return install::run_uninstall(purge);
        }
        None => {
            // Run as daemon (default behavior).
            // Installation is handled exclusively by the `install` subcommand,
            // invoked by the NSIS installer or deployment scripts.
        }
    }

    // Default: run as daemon (existing behavior)

    // Log Windows session context for diagnostics
    #[cfg(target_os = "windows")]
    agent_windows::session_detect::log_session_info();

    // If --helper-mode, run as helper process and exit
    #[cfg(target_os = "windows")]
    if cli.helper_mode {
        let pipe_name = cli
            .pipe_name
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("--pipe-name is required with --helper-mode"))?;
        info!("starting in helper mode with pipe: {}", pipe_name);
        return helper::run_helper_mode(pipe_name).await;
    }

    // Load or create config
    let config_path = cli
        .config_path
        .map(std::path::PathBuf::from)
        .unwrap_or_else(AgentConfig::default_path);

    let mut config = if config_path.exists() {
        info!("loading config from {}", config_path.display());
        AgentConfig::load(&config_path)?
    } else {
        info!("no config found, creating new");
        AgentConfig::default()
    };

    // CLI args override config file
    if let Some(url) = cli.server_url {
        config.server_url = url;
    }
    if let Some(token) = cli.enroll_token {
        config.enroll_token = Some(token);
    }

    if config.server_url.is_empty() {
        anyhow::bail!("server URL is required (--server-url or config file)");
    }

    // Enrollment: if we don't have a session token, enroll first
    if config.session_token.is_none() {
        if config.enroll_token.is_none() {
            anyhow::bail!(
                "no session token and no enrollment token — use --enroll-token for first-time setup"
            );
        }

        let (device_id, session_token) = connection::enroll(&config)
            .await
            .context("enrollment failed")?;

        config.device_id = Some(device_id);
        config.session_token = Some(session_token);
        config.enroll_token = None; // consumed

        config.save(&config_path)?;
        info!("config saved to {}", config_path.display());
    }

    // Run the agent
    run_agent(config, config_path).await
}

async fn run_agent(mut config: AgentConfig, config_path: std::path::PathBuf) -> Result<()> {
    // Detect if we need the helper process architecture (Windows Session 0)
    #[cfg(target_os = "windows")]
    let use_helper = agent_windows::session_detect::is_system_service_context();
    #[cfg(not(target_os = "windows"))]
    let use_helper = false;

    if use_helper {
        info!("Session 0 detected — using helper process for desktop/terminal");
    } else {
        info!("interactive session — handling desktop/terminal directly");
    }

    let (event_tx, mut event_rx) = mpsc::channel::<ServerEvent>(64);

    let handle = connection::run_connection(config.clone(), event_tx).await?;
    let mut session_mgr = SessionManager::new(handle.clone());
    let mut file_handler = create_file_handler()?;
    let telemetry = create_telemetry_collector()?;

    // --- Session 0: set up IPC + helper process ---
    #[cfg(target_os = "windows")]
    let ipc_writer: Option<std::sync::Arc<tokio::sync::Mutex<agent_windows::ipc::IpcWriter>>> =
        if use_helper {
            match setup_helper_ipc(&config, &handle).await {
                Ok(writer) => Some(writer),
                Err(e) => {
                    error!("failed to set up helper IPC: {:#}", e);
                    error!("desktop/terminal will not work in this session");
                    None
                }
            }
        } else {
            None
        };

    // Periodic telemetry every 60 seconds
    let mut telemetry_interval = tokio::time::interval(std::time::Duration::from_secs(60));
    telemetry_interval.tick().await; // consume the immediate first tick
    let mut authenticated = false;

    info!("agent running, press Ctrl+C to stop");

    loop {
        tokio::select! {
            event = event_rx.recv() => {
                match event {
                    Some(ServerEvent::Authenticated { device_id, session_token }) => {
                        info!("connected and authenticated as device {}", device_id);
                        authenticated = true;
                        // Update config with new session token if changed
                        if !session_token.is_empty() && config.session_token.as_deref() != Some(&session_token) {
                            config.session_token = Some(session_token);
                            config.device_id = Some(device_id.clone());
                            if let Err(e) = config.save(&config_path) {
                                warn!("failed to save updated config: {}", e);
                            }
                        }
                        // Send agent info
                        if let Err(e) = send_agent_info(&handle).await {
                            error!("failed to send agent info: {}", e);
                        }
                        // Send initial telemetry
                        telemetry.send_telemetry_quiet(&handle).await;
                    }
                    Some(ServerEvent::Message(msg)) => {
                        // In Session 0 mode, proxy desktop/terminal messages through IPC
                        #[cfg(target_os = "windows")]
                        if use_helper {
                            if is_session_message(msg.header.msg_type) {
                                if let Some(ref writer) = ipc_writer {
                                    let encoded = msg.encode();
                                    if let Err(e) = writer.lock().await.send_raw(&encoded).await {
                                        error!("failed to forward message to helper: {}", e);
                                    }
                                } else {
                                    warn!("no helper IPC — dropping session message 0x{:02x}", msg.header.msg_type);
                                }
                                continue;
                            }
                        }

                        handle_server_message(msg, &handle, &mut session_mgr, &mut file_handler, &telemetry, &config).await;
                    }
                    Some(ServerEvent::Disconnected) => {
                        warn!("disconnected from server, will reconnect...");
                        authenticated = false;
                        session_mgr.close_all();
                    }
                    None => {
                        info!("event channel closed, shutting down");
                        session_mgr.close_all();
                        break;
                    }
                }
            }
            _ = telemetry_interval.tick(), if authenticated => {
                telemetry.send_telemetry_quiet(&handle).await;
            }
            _ = tokio::signal::ctrl_c() => {
                info!("received Ctrl+C, shutting down");
                session_mgr.close_all();
                break;
            }
        }
    }

    Ok(())
}

/// Check if a message type is a session message (desktop or terminal)
/// that should be proxied to the helper process.
#[cfg(target_os = "windows")]
fn is_session_message(msg_type: u8) -> bool {
    matches!(
        msg_type,
        protocol::TERMINAL_OPEN
            | protocol::TERMINAL_CLOSE
            | protocol::TERMINAL_DATA
            | protocol::TERMINAL_RESIZE
            | protocol::DESKTOP_OPEN
            | protocol::DESKTOP_CLOSE
            | protocol::DESKTOP_INPUT
            | protocol::DESKTOP_QUALITY
    )
}

/// Set up IPC pipe server, spawn helper process, and start the relay task
/// that forwards helper responses back to the WebSocket.
#[cfg(target_os = "windows")]
async fn setup_helper_ipc(
    config: &AgentConfig,
    ws_handle: &ConnectionHandle,
) -> Result<std::sync::Arc<tokio::sync::Mutex<agent_windows::ipc::IpcWriter>>> {
    use agent_windows::ipc::{IpcServer, pipe_name_for_device};
    use agent_windows::helper_launcher::HelperLauncher;
    use agent_windows::session_detect::get_active_console_session;

    let device_id = config.device_id.as_deref().unwrap_or("default");
    let pipe_name = pipe_name_for_device(device_id);

    // Create the named pipe server
    let ipc_server = IpcServer::create(&pipe_name)
        .context("failed to create IPC pipe server")?;

    // Get the executable path for spawning the helper
    let exe_path = std::env::current_exe()
        .context("failed to get current exe path")?
        .to_string_lossy()
        .to_string();

    // Find the active console session
    let target_session = get_active_console_session()
        .ok_or_else(|| anyhow::anyhow!("no active console session found"))?;

    info!("spawning helper in session {} via {}", target_session, exe_path);

    // Spawn the helper process in the user session
    let mut launcher = HelperLauncher::new(exe_path.clone(), pipe_name.clone());
    launcher.spawn_in_session(target_session)
        .context("failed to spawn helper process")?;

    // Wait for the helper to connect to the pipe
    info!("waiting for helper to connect...");
    ipc_server.wait_for_connection().await
        .context("helper failed to connect to pipe")?;

    info!("helper connected, setting up relay");

    // Split the pipe into reader/writer
    let (reader, writer) = ipc_server.split();
    let writer = std::sync::Arc::new(tokio::sync::Mutex::new(writer));

    // Spawn relay task: reads messages from helper pipe → sends to WebSocket
    let ws_handle_clone = ws_handle.clone();
    let mut ipc_reader = reader;
    tokio::spawn(async move {
        loop {
            match ipc_reader.recv_raw().await {
                Ok(raw) => {
                    // Decode and forward to WebSocket
                    match protocol::Message::decode(&raw) {
                        Ok(Some((msg, _))) => {
                            if let Err(e) = ws_handle_clone.send_message(&msg).await {
                                error!("failed to relay helper message to server: {}", e);
                                break;
                            }
                        }
                        Ok(None) => {
                            warn!("incomplete message from helper pipe");
                        }
                        Err(e) => {
                            warn!("failed to decode helper message: {}", e);
                        }
                    }
                }
                Err(e) => {
                    warn!("helper pipe disconnected: {}", e);
                    break;
                }
            }
        }
        info!("helper relay task ended");
    });

    // Spawn a task to monitor helper process health and respawn if needed
    let _pipe_name_clone = pipe_name;
    let _exe_path_clone = exe_path;
    tokio::spawn(async move {
        let mut check_interval = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            check_interval.tick().await;

            if !launcher.is_alive() {
                warn!("helper process died, attempting respawn");

                // Check if session changed
                let new_session = get_active_console_session();
                match new_session {
                    Some(session_id) => {
                        if let Err(e) = launcher.spawn_in_session(session_id) {
                            error!("failed to respawn helper: {:#}", e);
                        } else {
                            info!("helper respawned in session {}", session_id);
                        }
                    }
                    None => {
                        warn!("no active console session, will retry later");
                    }
                }
            }
        }
    });

    Ok(writer)
}

async fn send_agent_info(handle: &ConnectionHandle) -> Result<()> {
    let info = protocol::AgentInfo {
        hostname: hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "unknown".to_string()),
        os_name: std::env::consts::OS.to_string(),
        os_version: get_os_version(),
        arch: std::env::consts::ARCH.to_string(),
        agent_version: env!("CARGO_PKG_VERSION").to_string(),
        cpu: None,
        memory: None,
        disks: None,
        network: None,
    };

    let msg = protocol::Message::control_json(protocol::AGENT_INFO, 0, &info)?;
    handle.send_message(&msg).await
}

async fn handle_server_message(
    msg: protocol::Message,
    handle: &ConnectionHandle,
    session_mgr: &mut SessionManager,
    file_handler: &mut FileHandler,
    telemetry: &TelemetryCollector,
    config: &AgentConfig,
) {
    match msg.header.msg_type {
        protocol::COMMAND => {
            handle_command(msg, handle, telemetry, config).await;
        }
        protocol::TERMINAL_OPEN
        | protocol::TERMINAL_CLOSE
        | protocol::TERMINAL_DATA
        | protocol::TERMINAL_RESIZE
        | protocol::DESKTOP_OPEN
        | protocol::DESKTOP_CLOSE
        | protocol::DESKTOP_INPUT
        | protocol::DESKTOP_QUALITY => {
            if let Err(e) = session_mgr.handle_message(msg).await {
                error!("session manager error: {:#}", e);
            }
        }
        protocol::FILE_LIST_REQ | protocol::FILE_DOWNLOAD_REQ | protocol::FILE_UPLOAD_START
        | protocol::FILE_UPLOAD_DATA | protocol::FILE_DELETE_REQ => {
            file_handler.handle_message(msg, handle).await;
        }
        protocol::TELEMETRY_REQ => {
            info!("received telemetry request");
            if let Err(e) = telemetry.send_telemetry(handle, msg.header.request_id).await {
                error!("failed to send telemetry: {:#}", e);
            }
        }
        other => {
            warn!("unhandled message type: 0x{:02x}", other);
        }
    }
}

async fn handle_command(
    msg: protocol::Message,
    handle: &ConnectionHandle,
    telemetry: &TelemetryCollector,
    config: &AgentConfig,
) {
    let payload_str = match std::str::from_utf8(&msg.payload) {
        Ok(s) => s,
        Err(_) => {
            send_command_result(handle, msg.header.request_id, false, Some("invalid UTF-8 payload")).await;
            return;
        }
    };

    let command: serde_json::Value = match serde_json::from_str(payload_str) {
        Ok(v) => v,
        Err(e) => {
            send_command_result(handle, msg.header.request_id, false, Some(&format!("invalid JSON: {}", e))).await;
            return;
        }
    };

    let cmd_type = command["type"].as_str().unwrap_or("");
    info!("received command: {}", cmd_type);

    match cmd_type {
        "REFRESH_TELEMETRY" => {
            if let Err(e) = telemetry.send_telemetry(handle, msg.header.request_id).await {
                send_command_result(handle, msg.header.request_id, false, Some(&format!("telemetry error: {}", e))).await;
            } else {
                send_command_result(handle, msg.header.request_id, true, None).await;
            }
        }
        "REBOOT" => {
            send_command_result(handle, msg.header.request_id, true, None).await;
            info!("executing reboot command");
            #[cfg(target_os = "linux")]
            {
                let _ = std::process::Command::new("reboot").spawn();
            }
            #[cfg(target_os = "windows")]
            {
                let _ = std::process::Command::new("shutdown").args(["/r", "/t", "0"]).spawn();
            }
        }
        "RUN_SHELL" => {
            let shell_cmd = command["command"].as_str().unwrap_or("");
            if shell_cmd.is_empty() {
                send_command_result(handle, msg.header.request_id, false, Some("missing 'command' field")).await;
                return;
            }
            info!("executing shell command: {}", shell_cmd);
            let output = {
                #[cfg(target_os = "windows")]
                {
                    std::process::Command::new("cmd").args(["/C", shell_cmd]).output()
                }
                #[cfg(not(target_os = "windows"))]
                {
                    std::process::Command::new("sh").args(["-c", shell_cmd]).output()
                }
            };
            match output {
                Ok(out) => {
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    let result = serde_json::json!({
                        "success": out.status.success(),
                        "exitCode": out.status.code(),
                        "stdout": stdout,
                        "stderr": stderr,
                    });
                    if let Ok(resp) = protocol::Message::control_json(protocol::COMMAND_RESULT, msg.header.request_id, &result) {
                        if let Err(e) = handle.send_message(&resp).await {
                            error!("failed to send command result: {}", e);
                        }
                    }
                }
                Err(e) => {
                    send_command_result(handle, msg.header.request_id, false, Some(&format!("exec error: {}", e))).await;
                }
            }
        }
        "UPDATE" => {
            info!("received update command, checking for updates...");
            match auto_update::perform_update(config).await {
                Ok(true) => {
                    send_command_result(handle, msg.header.request_id, true, None).await;
                    info!("update applied, restarting...");
                    if let Err(e) = auto_update::restart_self() {
                        error!("failed to restart after update: {}", e);
                    }
                }
                Ok(false) => {
                    send_command_result(handle, msg.header.request_id, true, None).await;
                }
                Err(e) => {
                    send_command_result(handle, msg.header.request_id, false, Some(&format!("update error: {:#}", e))).await;
                }
            }
        }
        _ => {
            warn!("unknown command type: {}", cmd_type);
            send_command_result(handle, msg.header.request_id, false, Some(&format!("unknown command: {}", cmd_type))).await;
        }
    }
}

async fn send_command_result(handle: &ConnectionHandle, request_id: u32, success: bool, error: Option<&str>) {
    let mut result = serde_json::json!({ "success": success });
    if let Some(err) = error {
        result["error"] = serde_json::Value::String(err.to_string());
    }
    if let Ok(resp) = protocol::Message::control_json(protocol::COMMAND_RESULT, request_id, &result) {
        if let Err(e) = handle.send_message(&resp).await {
            error!("failed to send command result: {}", e);
        }
    }
}

fn create_telemetry_collector() -> Result<TelemetryCollector> {
    let sys_info = create_platform_system_info()?;
    Ok(TelemetryCollector::new(sys_info))
}

fn create_file_handler() -> Result<FileHandler> {
    let fs = create_platform_filesystem()?;
    Ok(FileHandler::new(fs))
}

#[cfg(target_os = "linux")]
fn create_platform_filesystem() -> Result<Box<dyn agent_platform::filesystem::FileSystem>> {
    Ok(Box::new(agent_linux::filesystem::LinuxFileSystem::new()))
}

#[cfg(target_os = "macos")]
fn create_platform_filesystem() -> Result<Box<dyn agent_platform::filesystem::FileSystem>> {
    anyhow::bail!("filesystem not yet implemented for macOS")
}

#[cfg(target_os = "windows")]
fn create_platform_filesystem() -> Result<Box<dyn agent_platform::filesystem::FileSystem>> {
    Ok(Box::new(agent_windows::filesystem::WindowsFileSystem::new()))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn create_platform_filesystem() -> Result<Box<dyn agent_platform::filesystem::FileSystem>> {
    anyhow::bail!("filesystem not supported on this platform")
}

#[cfg(target_os = "linux")]
fn create_platform_system_info() -> Result<Box<dyn agent_platform::system_info::SystemInfo>> {
    Ok(Box::new(agent_linux::system_info::LinuxSystemInfo::new()))
}

#[cfg(target_os = "macos")]
fn create_platform_system_info() -> Result<Box<dyn agent_platform::system_info::SystemInfo>> {
    anyhow::bail!("system info not yet implemented for macOS")
}

#[cfg(target_os = "windows")]
fn create_platform_system_info() -> Result<Box<dyn agent_platform::system_info::SystemInfo>> {
    Ok(Box::new(agent_windows::system_info::WindowsSystemInfo::new()))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn create_platform_system_info() -> Result<Box<dyn agent_platform::system_info::SystemInfo>> {
    anyhow::bail!("system info not supported on this platform")
}

fn get_os_version() -> String {
    #[cfg(target_os = "linux")]
    {
        std::fs::read_to_string("/etc/os-release")
            .ok()
            .and_then(|content| {
                content
                    .lines()
                    .find(|l| l.starts_with("PRETTY_NAME="))
                    .map(|l| l.trim_start_matches("PRETTY_NAME=").trim_matches('"').to_string())
            })
            .unwrap_or_else(|| "Linux".to_string())
    }
    #[cfg(target_os = "windows")]
    {
        "Windows".to_string()
    }
    #[cfg(target_os = "macos")]
    {
        "macOS".to_string()
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        std::env::consts::OS.to_string()
    }
}
