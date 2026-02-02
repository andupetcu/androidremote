//! Windows Service Control Manager (SCM) — install/uninstall/start/stop the agent service.

#[cfg(target_os = "windows")]
use anyhow::{Context, Result};
#[cfg(target_os = "windows")]
use tracing::info;

#[cfg(target_os = "windows")]
use agent_platform::service::ServiceManager;

#[cfg(target_os = "windows")]
const SERVICE_NAME: &str = "AndroidRemoteAgent";
#[cfg(target_os = "windows")]
const DISPLAY_NAME: &str = "Android Remote Agent";

#[cfg(target_os = "windows")]
pub struct WindowsServiceManager {
    /// Path to the agent binary
    binary_path: String,
    /// Server URL for the service arguments
    server_url: String,
    /// Optional path to the config file
    config_path: Option<String>,
}

#[cfg(target_os = "windows")]
impl WindowsServiceManager {
    pub fn new(binary_path: String, server_url: String, config_path: Option<String>) -> Self {
        Self {
            binary_path,
            server_url,
            config_path,
        }
    }
}

#[cfg(target_os = "windows")]
impl ServiceManager for WindowsServiceManager {
    fn install(&self) -> Result<()> {
        info!("installing Windows service: {}", SERVICE_NAME);

        let mut bin_path = format!(
            "\"{}\" --server-url \"{}\"",
            self.binary_path, self.server_url
        );
        if let Some(ref cp) = self.config_path {
            bin_path.push_str(&format!(" --config-path \"{}\"", cp));
        }

        // Create the service via sc.exe
        let output = std::process::Command::new("sc.exe")
            .args([
                "create",
                SERVICE_NAME,
                &format!("binPath={}", bin_path),
                &format!("DisplayName={}", DISPLAY_NAME),
                "start=auto",
                "type=own",
            ])
            .output()
            .context("failed to run sc.exe create")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("sc.exe create failed: {}", stderr);
        }

        // Set description
        let _ = std::process::Command::new("sc.exe")
            .args([
                "description",
                SERVICE_NAME,
                "Cross-platform remote management agent",
            ])
            .output();

        // Configure recovery: restart on failure
        let _ = std::process::Command::new("sc.exe")
            .args([
                "failure",
                SERVICE_NAME,
                "reset=86400",
                "actions=restart/10000/restart/30000/restart/60000",
            ])
            .output();

        info!("service installed: {}", SERVICE_NAME);
        Ok(())
    }

    fn uninstall(&self) -> Result<()> {
        info!("uninstalling Windows service: {}", SERVICE_NAME);

        // Stop if running
        let _ = self.stop();

        // Wait briefly for stop to take effect
        std::thread::sleep(std::time::Duration::from_secs(2));

        let output = std::process::Command::new("sc.exe")
            .args(["delete", SERVICE_NAME])
            .output()
            .context("failed to run sc.exe delete")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("sc.exe delete failed: {}", stderr);
        }

        info!("service uninstalled: {}", SERVICE_NAME);
        Ok(())
    }

    fn start(&self) -> Result<()> {
        info!("starting service: {}", SERVICE_NAME);

        let output = std::process::Command::new("sc.exe")
            .args(["start", SERVICE_NAME])
            .output()
            .context("failed to start service")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("sc.exe start failed: {}", stderr);
        }

        Ok(())
    }

    fn stop(&self) -> Result<()> {
        info!("stopping service: {}", SERVICE_NAME);

        let output = std::process::Command::new("sc.exe")
            .args(["stop", SERVICE_NAME])
            .output()
            .context("failed to stop service")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // Not an error if already stopped
            if !stderr.contains("has not been started") && !stderr.contains("1062") {
                anyhow::bail!("sc.exe stop failed: {}", stderr);
            }
        }

        Ok(())
    }

    fn is_running(&self) -> Result<bool> {
        let output = std::process::Command::new("sc.exe")
            .args(["query", SERVICE_NAME])
            .output()
            .context("failed to query service")?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        // sc.exe query output contains "STATE" line with "RUNNING"
        Ok(stdout.contains("RUNNING"))
    }
}
