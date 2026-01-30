use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    /// Server URL (e.g., wss://server:7899)
    pub server_url: String,

    /// Enrollment token for first-time registration
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enroll_token: Option<String>,

    /// Session token (set after successful enrollment/auth)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_token: Option<String>,

    /// Device ID assigned by server
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,

    /// Heartbeat interval in seconds
    #[serde(default = "default_heartbeat_interval")]
    pub heartbeat_interval_secs: u64,

    /// Telemetry interval in seconds
    #[serde(default = "default_telemetry_interval")]
    pub telemetry_interval_secs: u64,

    /// Reconnect base delay in seconds
    #[serde(default = "default_reconnect_base_delay")]
    pub reconnect_base_delay_secs: u64,

    /// Reconnect max delay in seconds
    #[serde(default = "default_reconnect_max_delay")]
    pub reconnect_max_delay_secs: u64,
}

fn default_heartbeat_interval() -> u64 {
    30
}
fn default_telemetry_interval() -> u64 {
    60
}
fn default_reconnect_base_delay() -> u64 {
    1
}
fn default_reconnect_max_delay() -> u64 {
    60
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            server_url: String::new(),
            enroll_token: None,
            session_token: None,
            device_id: None,
            heartbeat_interval_secs: default_heartbeat_interval(),
            telemetry_interval_secs: default_telemetry_interval(),
            reconnect_base_delay_secs: default_reconnect_base_delay(),
            reconnect_max_delay_secs: default_reconnect_max_delay(),
        }
    }
}

impl AgentConfig {
    /// Default config file path for this platform
    pub fn default_path() -> PathBuf {
        if let Some(dirs) = directories::ProjectDirs::from("com", "android-remote", "agent") {
            dirs.config_dir().join("config.json")
        } else {
            PathBuf::from("agent-config.json")
        }
    }

    /// Load config from a file path
    pub fn load(path: &Path) -> Result<Self> {
        let data = std::fs::read_to_string(path)
            .with_context(|| format!("failed to read config from {}", path.display()))?;
        let config: Self =
            serde_json::from_str(&data).with_context(|| "failed to parse config JSON")?;
        Ok(config)
    }

    /// Save config to a file path
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create config dir {}", parent.display()))?;
        }
        let data = serde_json::to_string_pretty(self)?;
        std::fs::write(path, data)
            .with_context(|| format!("failed to write config to {}", path.display()))?;
        Ok(())
    }

    /// Get the relay WebSocket URL
    pub fn relay_url(&self) -> String {
        let base = self.server_url.trim_end_matches('/');
        // Convert http(s) scheme to ws(s) for WebSocket connections
        let ws_base = if base.starts_with("https://") {
            base.replacen("https://", "wss://", 1)
        } else if base.starts_with("http://") {
            base.replacen("http://", "ws://", 1)
        } else {
            base.to_string()
        };
        format!("{}/relay", ws_base)
    }

    /// Get the enrollment HTTP URL
    pub fn enroll_url(&self) -> String {
        let base = self
            .server_url
            .replace("wss://", "https://")
            .replace("ws://", "http://");
        let base = base.trim_end_matches('/');
        format!("{}/api/enroll/device", base)
    }
}
