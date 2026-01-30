use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CpuInfo {
    pub model: String,
    pub cores: u32,
    pub threads: u32,
    pub usage_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryInfo {
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub available_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskInfo {
    pub mount_point: String,
    pub filesystem: String,
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub available_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkInfo {
    pub name: String,
    pub mac_address: Option<String>,
    pub ipv4: Option<String>,
    pub ipv6: Option<String>,
}

pub trait SystemInfo: Send + Sync {
    fn hostname(&self) -> String;
    fn os_name(&self) -> String;
    fn os_version(&self) -> String;
    fn arch(&self) -> String;
    fn cpu_info(&self) -> CpuInfo;
    fn memory_info(&self) -> MemoryInfo;
    fn disk_info(&self) -> Vec<DiskInfo>;
    fn network_interfaces(&self) -> Vec<NetworkInfo>;
}
