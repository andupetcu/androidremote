//! Auto-update: check for updates, download, verify checksum, replace binary.

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use tracing::info;

use crate::config::AgentConfig;

/// Response from GET /api/agent/latest
#[derive(Debug, serde::Deserialize)]
pub struct LatestVersionInfo {
    pub version: String,
    pub url: String,
    pub sha256: String,
}

/// Check for an available update. Returns Some(info) if a newer version exists.
pub async fn check_for_update(config: &AgentConfig) -> Result<Option<LatestVersionInfo>> {
    let base = config
        .server_url
        .replace("wss://", "https://")
        .replace("ws://", "http://");
    let base = base.trim_end_matches('/');

    let os = std::env::consts::OS;
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "arm" => "armv7l",
        other => other,
    };

    let url = format!("{}/api/agent/latest?os={}&arch={}", base, os, arch);

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .send()
        .await
        .context("failed to check for update")?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        info!("no update available (server returned 404)");
        return Ok(None);
    }

    if !resp.status().is_success() {
        anyhow::bail!("update check failed: HTTP {}", resp.status());
    }

    let info: LatestVersionInfo = resp.json().await.context("invalid update response")?;

    let current_version = env!("CARGO_PKG_VERSION");
    if info.version == current_version {
        info!("agent is up to date (v{})", current_version);
        return Ok(None);
    }

    info!(
        "update available: v{} -> v{}",
        current_version, info.version
    );
    Ok(Some(info))
}

/// Download the update binary, verify its SHA-256, and replace the current executable.
/// Returns the path to the new binary (which is the current exe path after replacement).
pub async fn download_and_apply(info: &LatestVersionInfo) -> Result<()> {
    let current_exe = std::env::current_exe().context("failed to get current exe path")?;

    info!("downloading update from {}", info.url);

    let client = reqwest::Client::new();
    let resp = client
        .get(&info.url)
        .send()
        .await
        .context("failed to download update")?;

    if !resp.status().is_success() {
        anyhow::bail!("download failed: HTTP {}", resp.status());
    }

    let bytes = resp.bytes().await.context("failed to read update body")?;

    // Verify SHA-256
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let hash = format!("{:x}", hasher.finalize());

    if hash != info.sha256 {
        anyhow::bail!(
            "checksum mismatch: expected {}, got {}",
            info.sha256,
            hash
        );
    }

    info!("checksum verified, applying update ({} bytes)", bytes.len());

    // Write to a temp file next to the current binary
    let tmp_path = current_exe.with_extension("update");

    std::fs::write(&tmp_path, &bytes)
        .with_context(|| format!("failed to write update to {}", tmp_path.display()))?;

    // Set executable permission on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o755))
            .context("failed to set executable permission")?;
    }

    // Replace the current binary
    // On Unix: rename is atomic
    // On Windows: the running exe may be locked, so we rename the old one first
    #[cfg(windows)]
    {
        let backup_path = current_exe.with_extension("old");
        // Remove previous backup if it exists
        let _ = std::fs::remove_file(&backup_path);
        // Rename current -> backup
        std::fs::rename(&current_exe, &backup_path)
            .context("failed to rename current exe to backup")?;
        // Rename new -> current
        if let Err(e) = std::fs::rename(&tmp_path, &current_exe) {
            // Try to restore backup
            let _ = std::fs::rename(&backup_path, &current_exe);
            return Err(e).context("failed to rename update to current exe");
        }
    }

    #[cfg(not(windows))]
    {
        std::fs::rename(&tmp_path, &current_exe)
            .context("failed to rename update into place")?;
    }

    info!("update applied successfully (v{})", info.version);
    Ok(())
}

/// Perform a full update check + download + apply cycle.
/// Returns true if an update was applied (caller should restart).
pub async fn perform_update(config: &AgentConfig) -> Result<bool> {
    match check_for_update(config).await? {
        Some(info) => {
            download_and_apply(&info).await?;
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Request a process restart by spawning the current exe and exiting.
pub fn restart_self() -> Result<()> {
    let exe = std::env::current_exe().context("failed to get current exe")?;
    let args: Vec<String> = std::env::args().skip(1).collect();

    info!("restarting agent: {} {:?}", exe.display(), args);

    std::process::Command::new(&exe)
        .args(&args)
        .spawn()
        .context("failed to spawn new agent process")?;

    // Exit current process
    std::process::exit(0);
}
