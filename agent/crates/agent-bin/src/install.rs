//! Cross-platform install/uninstall orchestration.
//!
//! Handles: copying binary, enrolling, saving config, registering and starting the service.

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

// ── Install parameters ─────────────────────────────────────────────────────

struct InstallConfig {
    server_url: String,
    enroll_token: String,
    install_dir: String,
    install_service: bool,
    start_service: bool,
}

// ── Public entry points ────────────────────────────────────────────────────

/// Main install entry point. Dispatches to interactive or silent mode.
pub async fn run_install(
    silent: bool,
    install_dir: Option<String>,
    server_url: Option<String>,
    enroll_token: Option<String>,
) -> Result<()> {
    // Step 1: Ensure we have admin/root privileges
    ensure_elevated(silent)?;

    // Step 2: Collect install parameters
    let params = if silent {
        let server = server_url
            .context("--server-url is required in silent mode")?;
        let token = enroll_token
            .context("--enroll-token is required in silent mode")?;

        InstallConfig {
            server_url: server,
            enroll_token: token,
            install_dir: install_dir.unwrap_or_else(|| DEFAULT_INSTALL_DIR.to_string()),
            install_service: true,
            start_service: true,
        }
    } else {
        collect_interactive_params(install_dir, server_url, enroll_token)?
    };

    // Step 3: Run the install
    let result = perform_install(&params).await;

    // Step 4: Report result
    match &result {
        Ok(()) => {
            let msg = format!(
                "Android Remote Agent installed successfully!\n\nInstall directory: {}\nService registered and started.",
                params.install_dir
            );
            show_success(&msg, silent);
        }
        Err(e) => {
            let msg = format!("Installation failed: {:#}", e);
            show_error(&msg, silent);
        }
    }

    result
}

/// Main uninstall entry point.
pub fn run_uninstall(purge: bool) -> Result<()> {
    ensure_elevated_sync()?;

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

async fn perform_install(params: &InstallConfig) -> Result<()> {
    // Validate inputs before proceeding
    validate_server_url(&params.server_url)?;
    validate_enroll_token(&params.enroll_token)?;
    let install_dir = std::path::Path::new(&params.install_dir);
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
    info!("enrolling with server {}...", params.server_url);
    let mut config = AgentConfig::default();
    config.server_url = params.server_url.clone();
    config.enroll_token = Some(params.enroll_token.clone());

    let (device_id, session_token) = connection::enroll(&config)
        .await
        .context("enrollment failed — check server URL and token")?;

    info!("enrolled as device {}", device_id);

    // 4. Save config
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
    if params.install_service {
        install_service(
            binary_dest.to_string_lossy().as_ref(),
            &params.server_url,
            config_dest.to_string_lossy().as_ref(),
        )?;
        info!("service registered");

        if params.start_service {
            start_service(
                binary_dest.to_string_lossy().as_ref(),
                &params.server_url,
            )?;
            info!("service started");
        }
    }

    Ok(())
}

// ── Privilege checks ───────────────────────────────────────────────────────

fn ensure_elevated(#[allow(unused)] silent: bool) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        if !agent_windows::installer::is_elevated() {
            if silent {
                anyhow::bail!("this command must be run as Administrator (use an elevated command prompt)");
            }
            // Re-launch with UAC
            let args = std::env::args().skip(1).collect::<Vec<_>>().join(" ");
            agent_windows::installer::relaunch_elevated(&args)?;
            // relaunch_elevated exits the process on success
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

fn ensure_elevated_sync() -> Result<()> {
    ensure_elevated(true)
}

// ── Interactive parameter collection ───────────────────────────────────────

fn collect_interactive_params(
    install_dir: Option<String>,
    server_url: Option<String>,
    enroll_token: Option<String>,
) -> Result<InstallConfig> {
    #[cfg(target_os = "windows")]
    {
        let _ = (install_dir.as_ref(), server_url.as_ref(), enroll_token.as_ref());
        // Show Win32 dialog
        match agent_windows::installer::show_install_dialog() {
            Some(params) => Ok(InstallConfig {
                server_url: params.server_url,
                enroll_token: params.enroll_token,
                install_dir: install_dir.unwrap_or_else(|| DEFAULT_INSTALL_DIR.to_string()),
                install_service: params.install_service,
                start_service: params.start_service,
            }),
            None => {
                // User cancelled
                std::process::exit(0);
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Terminal-based interactive prompts
        use std::io::{self, BufRead, Write};

        let stdin = io::stdin();
        let stdout = io::stdout();
        let mut stdout = stdout.lock();

        let server = if let Some(url) = server_url {
            url
        } else {
            write!(stdout, "Server URL (e.g., https://server:7899): ")?;
            stdout.flush()?;
            let mut line = String::new();
            stdin.lock().read_line(&mut line)?;
            let trimmed = line.trim().to_string();
            if trimmed.is_empty() {
                anyhow::bail!("server URL is required");
            }
            trimmed
        };

        let token = if let Some(t) = enroll_token {
            t
        } else {
            write!(stdout, "Enrollment token: ")?;
            stdout.flush()?;
            let mut line = String::new();
            stdin.lock().read_line(&mut line)?;
            let trimmed = line.trim().to_string();
            if trimmed.is_empty() {
                anyhow::bail!("enrollment token is required");
            }
            trimmed
        };

        Ok(InstallConfig {
            server_url: server,
            enroll_token: token,
            install_dir: install_dir.unwrap_or_else(|| DEFAULT_INSTALL_DIR.to_string()),
            install_service: true,
            start_service: true,
        })
    }
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

// ── User feedback ──────────────────────────────────────────────────────────

fn show_success(message: &str, silent: bool) {
    if silent {
        info!("{}", message);
    } else {
        #[cfg(target_os = "windows")]
        agent_windows::installer::show_message_box("Installation Complete", message, false);
        #[cfg(not(target_os = "windows"))]
        {
            println!("\n✓ {}", message);
        }
    }
}

fn show_error(message: &str, silent: bool) {
    if silent {
        eprintln!("ERROR: {}", message);
    } else {
        #[cfg(target_os = "windows")]
        agent_windows::installer::show_message_box("Installation Failed", message, true);
        #[cfg(not(target_os = "windows"))]
        {
            eprintln!("\n✗ {}", message);
        }
    }
}
