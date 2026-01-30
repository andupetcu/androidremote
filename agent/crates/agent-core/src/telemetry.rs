use anyhow::Result;
use serde::Serialize;
use tracing::{error, info};

use agent_platform::system_info::{CpuInfo, DiskInfo, MemoryInfo, NetworkInfo, SystemInfo};
use crate::connection::ConnectionHandle;
use crate::protocol;

/// Telemetry data sent to the server
#[derive(Debug, Clone, Serialize)]
pub struct TelemetryData {
    pub cpu: CpuInfo,
    pub memory: MemoryInfo,
    pub disks: Vec<DiskInfo>,
    pub network: Vec<NetworkInfo>,
    pub uptime_ms: Option<u64>,
    pub hostname: String,
    pub os_name: String,
    pub os_version: String,
    pub arch: String,
}

/// Collects and sends system telemetry
pub struct TelemetryCollector {
    sys_info: Box<dyn SystemInfo>,
}

impl TelemetryCollector {
    pub fn new(sys_info: Box<dyn SystemInfo>) -> Self {
        Self { sys_info }
    }

    /// Collect current telemetry data
    pub fn collect(&self) -> TelemetryData {
        TelemetryData {
            cpu: self.sys_info.cpu_info(),
            memory: self.sys_info.memory_info(),
            disks: self.sys_info.disk_info(),
            network: self.sys_info.network_interfaces(),
            uptime_ms: read_uptime_ms(),
            hostname: self.sys_info.hostname(),
            os_name: self.sys_info.os_name(),
            os_version: self.sys_info.os_version(),
            arch: self.sys_info.arch(),
        }
    }

    /// Collect and send telemetry to the server
    pub async fn send_telemetry(&self, handle: &ConnectionHandle, request_id: u32) -> Result<()> {
        let data = self.collect();
        let msg = protocol::Message::control_json(protocol::TELEMETRY_DATA, request_id, &data)?;
        handle.send_message(&msg).await?;
        info!("telemetry sent (cpu: {:.1}%, mem: {}/{})",
            data.cpu.usage_percent,
            format_bytes(data.memory.used_bytes),
            format_bytes(data.memory.total_bytes),
        );
        Ok(())
    }

    /// Send telemetry, logging errors instead of propagating
    pub async fn send_telemetry_quiet(&self, handle: &ConnectionHandle) {
        if let Err(e) = self.send_telemetry(handle, 0).await {
            error!("failed to send telemetry: {:#}", e);
        }
    }
}

fn read_uptime_ms() -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let content = std::fs::read_to_string("/proc/uptime").ok()?;
        let secs: f64 = content.split_whitespace().next()?.parse().ok()?;
        Some((secs * 1000.0) as u64)
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

fn format_bytes(bytes: u64) -> String {
    if bytes == 0 {
        return "0 B".to_string();
    }
    let units = ["B", "KB", "MB", "GB", "TB"];
    let i = (bytes as f64).log(1024.0).floor() as usize;
    let i = i.min(units.len() - 1);
    let val = bytes as f64 / 1024f64.powi(i as i32);
    if i == 0 {
        format!("{} {}", val as u64, units[i])
    } else {
        format!("{:.1} {}", val, units[i])
    }
}
