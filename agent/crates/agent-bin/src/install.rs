//! Cross-platform install/uninstall orchestration (silent mode only).
//!
//! Handles: copying binary, enrolling, saving config, registering and starting the service.
//! Interactive installation is handled by the NSIS installer (Windows) or deployment scripts.

use anyhow::{Context, Result};
use tracing::info;

use agent_core::config::AgentConfig;
use agent_core::connection;

// ── Platform constants ─────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
const DEFAULT_INSTALL_DIR: &str = r"C:\Program Files\AndroidRemoteAgent";
#[cfg(target_os = "linux")]
const DEFAULT_INSTALL_DIR: &str = "/opt/android-remote-agent";
#[cfg(not(any(target_os = "windows", target_os = "linux")))]
const DEFAULT_INSTALL_DIR: &str = "/opt/android-remote-agent";

#[cfg(target_os = "windows")]
const BINARY_NAME: &str = "android-remote-agent.exe";
#[cfg(not(target_os = "windows"))]
const BINARY_NAME: &str = "android-remote-agent";

// ── Public entry points ────────────────────────────────────────────────────

/// Install the agent as a system service (silent/unattended only).
///
/// Called by the NSIS installer post-install step or by deployment scripts.
/// Requires elevated privileges (NSIS runs elevated; Linux scripts use sudo).
pub async fn run_install(
    install_dir: Option<String>,
    server_url: Option<String>,
    enroll_token: Option<String>,
) -> Result<()> {
    ensure_elevated()?;

    let server = server_url
        .context("--server-url is required")?;
    let token = enroll_token
        .context("--enroll-token is required")?;
    let dir = install_dir.unwrap_or_else(|| DEFAULT_INSTALL_DIR.to_string());

    let result = perform_install(&server, &token, &dir).await;

    match &result {
        Ok(()) => {
            info!(
                "Android Remote Agent installed successfully! Install directory: {}, service registered and started.",
                dir
            );
        }
        Err(e) => {
            eprintln!("ERROR: Installation failed: {:#}", e);
        }
    }

    result
}

/// Main uninstall entry point.
pub fn run_uninstall(purge: bool) -> Result<()> {
    ensure_elevated()?;

    info!("uninstalling agent service...");

    // Stop and remove the service
    uninstall_service()?;

    if purge {
        info!("purging install directory: {}", DEFAULT_INSTALL_DIR);
        let dir = std::path::Path::new(DEFAULT_INSTALL_DIR);
        if dir.exists() {
            std::fs::remove_dir_all(dir)
                .with_context(|| format!("failed to remove {}", DEFAULT_INSTALL_DIR))?;
            info!("install directory removed");
        }
    }

    info!("agent uninstalled successfully");
    Ok(())
}

// ── Input validation ───────────────────────────────────────────────────────

/// Validate a server URL to prevent injection in service configs and shell scripts.
fn validate_server_url(url: &str) -> Result<()> {
    let url = url.trim();
    if url.is_empty() {
        anyhow::bail!("server URL cannot be empty");
    }
    if !url.starts_with("http://")
        && !url.starts_with("https://")
        && !url.starts_with("ws://")
        && !url.starts_with("wss://")
    {
        anyhow::bail!("server URL must start with http://, https://, ws://, or wss://");
    }
    // Reject characters that could be used for shell/systemd/sc.exe injection
    if url.contains('"') || url.contains('\'') || url.contains('\n')
        || url.contains('\r') || url.contains(';') || url.contains('&')
        || url.contains('|') || url.contains('`') || url.contains('$')
        || url.contains('\\')
    {
        anyhow::bail!("server URL contains invalid characters");
    }
    Ok(())
}

/// Validate an enrollment token.
fn validate_enroll_token(token: &str) -> Result<()> {
    let token = token.trim();
    if token.is_empty() {
        anyhow::bail!("enrollment token cannot be empty");
    }
    // Tokens should be alphanumeric
    if !token.chars().all(|c| c.is_ascii_alphanumeric()) {
        anyhow::bail!("enrollment token must be alphanumeric");
    }
    Ok(())
}

// ── Install implementation ─────────────────────────────────────────────────

async fn perform_install(server_url: &str, enroll_token: &str, install_dir_str: &str) -> Result<()> {
    // Validate inputs before proceeding
    validate_server_url(server_url)?;
    validate_enroll_token(enroll_token)?;
    let install_dir = std::path::Path::new(install_dir_str);
    let binary_dest = install_dir.join(BINARY_NAME);
    let config_dest = install_dir.join("config.json");

    // 1. Create install directory
    std::fs::create_dir_all(install_dir)
        .with_context(|| format!("failed to create install dir {}", install_dir.display()))?;
    info!("install directory: {}", install_dir.display());

    // 2. Copy binary to install location
    let current_exe = std::env::current_exe().context("failed to get current exe path")?;
    if current_exe != binary_dest {
        std::fs::copy(&current_exe, &binary_dest).with_context(|| {
            format!(
                "failed to copy binary from {} to {}",
                current_exe.display(),
                binary_dest.display()
            )
        })?;
        info!("binary copied to {}", binary_dest.display());
    } else {
        info!("binary already in install location");
    }

    // On Linux, ensure the binary is executable
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&binary_dest, std::fs::Permissions::from_mode(0o755))
            .context("failed to set binary permissions")?;
    }

    // 3. Enroll with server
    info!("enrolling with server {}...", server_url);
    let mut config = AgentConfig::default();
    config.server_url = server_url.to_string();
    config.enroll_token = Some(enroll_token.to_string());

    let (device_id, session_token) = connection::enroll(&config)
        .await
        .context("enrollment failed — check server URL and token")?;

    info!("enrolled as device {}", device_id);

    // 4. Save config to install directory (not AppData)
    config.device_id = Some(device_id);
    config.session_token = Some(session_token);
    config.enroll_token = None;
    config.save(&config_dest)?;
    info!("config saved to {}", config_dest.display());

    // Restrict config file permissions (contains session token)
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&config_dest, std::fs::Permissions::from_mode(0o600))
            .context("failed to set config file permissions")?;

        // Set ownership of install dir to the service user
        let _ = std::process::Command::new("chown")
            .args(["-R", "android-remote-agent:android-remote-agent"])
            .arg(install_dir)
            .status();
    }

    // 5. Register and start the system service
    install_service(
        binary_dest.to_string_lossy().as_ref(),
        server_url,
        config_dest.to_string_lossy().as_ref(),
    )?;
    info!("service registered");

    start_service(
        binary_dest.to_string_lossy().as_ref(),
        server_url,
    )?;
    info!("service started");

    Ok(())
}

// ── Privilege checks ───────────────────────────────────────────────────────

fn ensure_elevated() -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        if !agent_windows::installer::is_elevated() {
            anyhow::bail!("this command must be run as Administrator (use an elevated command prompt)");
        }
    }
    #[cfg(target_os = "linux")]
    {
        if !nix::unistd::Uid::effective().is_root() {
            anyhow::bail!("this command must be run as root (use sudo)");
        }
    }
    Ok(())
}

// ── Service management wrappers ────────────────────────────────────────────

fn install_service(binary_path: &str, server_url: &str, config_path: &str) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        use agent_platform::service::ServiceManager;
        let mgr = agent_windows::service::WindowsServiceManager::new(
            binary_path.to_string(),
            server_url.to_string(),
            Some(config_path.to_string()),
        );
        mgr.install()
    }
    #[cfg(target_os = "linux")]
    {
        use agent_platform::service::ServiceManager;
        let mgr = agent_linux::service::SystemdServiceManager::new(
            binary_path.to_string(),
            server_url.to_string(),
            Some(config_path.to_string()),
        );
        mgr.install()
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = (binary_path, server_url, config_path);
        anyhow::bail!("service installation not supported on this platform")
    }
}

fn start_service(binary_path: &str, server_url: &str) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        use agent_platform::service::ServiceManager;
        let mgr = agent_windows::service::WindowsServiceManager::new(
            binary_path.to_string(),
            server_url.to_string(),
            None,
        );
        mgr.start()
    }
    #[cfg(target_os = "linux")]
    {
        use agent_platform::service::ServiceManager;
        let mgr = agent_linux::service::SystemdServiceManager::new(
            binary_path.to_string(),
            server_url.to_string(),
            None,
        );
        mgr.start()
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = (binary_path, server_url);
        anyhow::bail!("service management not supported on this platform")
    }
}

fn uninstall_service() -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        use agent_platform::service::ServiceManager;
        let mgr = agent_windows::service::WindowsServiceManager::new(
            String::new(),
            String::new(),
            None,
        );
        mgr.uninstall()
    }
    #[cfg(target_os = "linux")]
    {
        use agent_platform::service::ServiceManager;
        let mgr = agent_linux::service::SystemdServiceManager::new(
            String::new(),
            String::new(),
            None,
        );
        mgr.uninstall()
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        anyhow::bail!("service management not supported on this platform")
    }
}
