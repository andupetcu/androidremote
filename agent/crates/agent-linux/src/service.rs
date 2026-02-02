//! Linux systemd service management — install/uninstall/start/stop the agent service.

use anyhow::{Context, Result};
use tracing::info;

use agent_platform::service::ServiceManager;

const SERVICE_NAME: &str = "android-remote-agent";
const SERVICE_UNIT_PATH: &str = "/etc/systemd/system/android-remote-agent.service";

pub struct SystemdServiceManager {
    /// Path to the agent binary
    binary_path: String,
    /// Server URL for the ExecStart command
    server_url: String,
    /// Optional path to the config file
    config_path: Option<String>,
}

impl SystemdServiceManager {
    pub fn new(binary_path: String, server_url: String, config_path: Option<String>) -> Self {
        Self {
            binary_path,
            server_url,
            config_path,
        }
    }

    fn generate_unit_file(&self) -> String {
        let config_arg = match &self.config_path {
            Some(cp) => format!(" --config-path {}", cp),
            None => String::new(),
        };
        format!(
            r#"[Unit]
Description=Android Remote Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User={user}
ExecStart={binary} --server-url {server}{config_arg}
Restart=always
RestartSec=10
Environment=AGENT_LOG_LEVEL=info

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/android-remote-agent
PrivateTmp=true

[Install]
WantedBy=multi-user.target
"#,
            user = SERVICE_NAME,
            binary = self.binary_path,
            server = self.server_url,
            config_arg = config_arg,
        )
    }
}

impl ServiceManager for SystemdServiceManager {
    fn install(&self) -> Result<()> {
        info!("installing systemd service: {}", SERVICE_NAME);

        // Create system user if it doesn't exist
        let user_check = std::process::Command::new("id")
            .arg(SERVICE_NAME)
            .output();

        if user_check.map(|o| !o.status.success()).unwrap_or(true) {
            info!("creating system user: {}", SERVICE_NAME);
            let status = std::process::Command::new("useradd")
                .args(["--system", "--no-create-home", "--shell", "/usr/sbin/nologin", SERVICE_NAME])
                .status()
                .context("failed to create system user")?;

            if !status.success() {
                anyhow::bail!("useradd failed with exit code {:?}", status.code());
            }
        }

        // Write unit file
        let unit = self.generate_unit_file();
        std::fs::write(SERVICE_UNIT_PATH, unit)
            .with_context(|| format!("failed to write {}", SERVICE_UNIT_PATH))?;

        // Reload systemd
        let status = std::process::Command::new("systemctl")
            .arg("daemon-reload")
            .status()
            .context("failed to run systemctl daemon-reload")?;

        if !status.success() {
            anyhow::bail!("systemctl daemon-reload failed");
        }

        // Enable service
        let status = std::process::Command::new("systemctl")
            .args(["enable", SERVICE_NAME])
            .status()
            .context("failed to enable service")?;

        if !status.success() {
            anyhow::bail!("systemctl enable failed");
        }

        info!("service installed and enabled: {}", SERVICE_NAME);
        Ok(())
    }

    fn uninstall(&self) -> Result<()> {
        info!("uninstalling systemd service: {}", SERVICE_NAME);

        // Stop if running
        let _ = self.stop();

        // Disable service
        let _ = std::process::Command::new("systemctl")
            .args(["disable", SERVICE_NAME])
            .status();

        // Remove unit file
        if std::path::Path::new(SERVICE_UNIT_PATH).exists() {
            std::fs::remove_file(SERVICE_UNIT_PATH)
                .context("failed to remove unit file")?;
        }

        // Reload systemd
        let _ = std::process::Command::new("systemctl")
            .arg("daemon-reload")
            .status();

        info!("service uninstalled: {}", SERVICE_NAME);
        Ok(())
    }

    fn start(&self) -> Result<()> {
        info!("starting service: {}", SERVICE_NAME);
        let status = std::process::Command::new("systemctl")
            .args(["start", SERVICE_NAME])
            .status()
            .context("failed to start service")?;

        if !status.success() {
            anyhow::bail!("systemctl start failed");
        }
        Ok(())
    }

    fn stop(&self) -> Result<()> {
        info!("stopping service: {}", SERVICE_NAME);
        let status = std::process::Command::new("systemctl")
            .args(["stop", SERVICE_NAME])
            .status()
            .context("failed to stop service")?;

        if !status.success() {
            anyhow::bail!("systemctl stop failed");
        }
        Ok(())
    }

    fn is_running(&self) -> Result<bool> {
        let output = std::process::Command::new("systemctl")
            .args(["is-active", SERVICE_NAME])
            .output()
            .context("failed to check service status")?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(stdout.trim() == "active")
    }
}
