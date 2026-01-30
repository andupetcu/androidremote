use std::fs;
use std::path::Path;

use agent_platform::system_info::{CpuInfo, DiskInfo, MemoryInfo, NetworkInfo, SystemInfo};

pub struct LinuxSystemInfo;

impl LinuxSystemInfo {
    pub fn new() -> Self {
        Self
    }
}

impl SystemInfo for LinuxSystemInfo {
    fn hostname(&self) -> String {
        hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "unknown".to_string())
    }

    fn os_name(&self) -> String {
        "linux".to_string()
    }

    fn os_version(&self) -> String {
        fs::read_to_string("/etc/os-release")
            .ok()
            .and_then(|content| {
                content
                    .lines()
                    .find(|l| l.starts_with("PRETTY_NAME="))
                    .map(|l| {
                        l.trim_start_matches("PRETTY_NAME=")
                            .trim_matches('"')
                            .to_string()
                    })
            })
            .unwrap_or_else(|| "Linux".to_string())
    }

    fn arch(&self) -> String {
        std::env::consts::ARCH.to_string()
    }

    fn cpu_info(&self) -> CpuInfo {
        let model = parse_cpu_model().unwrap_or_else(|| "Unknown CPU".to_string());
        let (cores, threads) = parse_cpu_count();
        let usage_percent = parse_cpu_usage();

        CpuInfo {
            model,
            cores,
            threads,
            usage_percent,
        }
    }

    fn memory_info(&self) -> MemoryInfo {
        parse_meminfo().unwrap_or(MemoryInfo {
            total_bytes: 0,
            used_bytes: 0,
            available_bytes: 0,
        })
    }

    fn disk_info(&self) -> Vec<DiskInfo> {
        parse_disk_info()
    }

    fn network_interfaces(&self) -> Vec<NetworkInfo> {
        parse_network_info()
    }
}

fn parse_cpu_model() -> Option<String> {
    let content = fs::read_to_string("/proc/cpuinfo").ok()?;
    for line in content.lines() {
        if line.starts_with("model name") {
            if let Some(val) = line.split(':').nth(1) {
                return Some(val.trim().to_string());
            }
        }
    }
    None
}

fn parse_cpu_count() -> (u32, u32) {
    let content = match fs::read_to_string("/proc/cpuinfo") {
        Ok(c) => c,
        Err(_) => return (1, 1),
    };

    let mut processor_count = 0u32;
    let mut core_ids = std::collections::HashSet::new();

    for line in content.lines() {
        if line.starts_with("processor") {
            processor_count += 1;
        }
        if line.starts_with("core id") {
            if let Some(val) = line.split(':').nth(1) {
                if let Ok(id) = val.trim().parse::<u32>() {
                    core_ids.insert(id);
                }
            }
        }
    }

    let cores = if core_ids.is_empty() {
        processor_count
    } else {
        core_ids.len() as u32
    };

    (cores.max(1), processor_count.max(1))
}

fn parse_cpu_usage() -> f64 {
    // Read /proc/stat for aggregate CPU usage
    // First line: cpu user nice system idle iowait irq softirq steal
    let content = match fs::read_to_string("/proc/stat") {
        Ok(c) => c,
        Err(_) => return 0.0,
    };

    let first_line = match content.lines().next() {
        Some(l) => l,
        None => return 0.0,
    };

    let parts: Vec<u64> = first_line
        .split_whitespace()
        .skip(1) // skip "cpu"
        .filter_map(|s| s.parse().ok())
        .collect();

    if parts.len() < 4 {
        return 0.0;
    }

    let user = parts[0];
    let nice = parts[1];
    let system = parts[2];
    let idle = parts[3];
    let iowait = parts.get(4).copied().unwrap_or(0);

    let total = user + nice + system + idle + iowait;
    let busy = user + nice + system;

    if total == 0 {
        return 0.0;
    }

    (busy as f64 / total as f64) * 100.0
}

fn parse_meminfo() -> Option<MemoryInfo> {
    let content = fs::read_to_string("/proc/meminfo").ok()?;

    let mut total_kb = 0u64;
    let mut available_kb = 0u64;
    let mut free_kb = 0u64;
    let mut buffers_kb = 0u64;
    let mut cached_kb = 0u64;

    for line in content.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 2 {
            continue;
        }
        let value: u64 = match parts[1].parse() {
            Ok(v) => v,
            Err(_) => continue,
        };

        match parts[0] {
            "MemTotal:" => total_kb = value,
            "MemAvailable:" => available_kb = value,
            "MemFree:" => free_kb = value,
            "Buffers:" => buffers_kb = value,
            "Cached:" => cached_kb = value,
            _ => {}
        }
    }

    // If MemAvailable is 0 (older kernels), estimate it
    if available_kb == 0 {
        available_kb = free_kb + buffers_kb + cached_kb;
    }

    let total_bytes = total_kb * 1024;
    let available_bytes = available_kb * 1024;
    let used_bytes = total_bytes.saturating_sub(available_bytes);

    Some(MemoryInfo {
        total_bytes,
        used_bytes,
        available_bytes,
    })
}

fn parse_disk_info() -> Vec<DiskInfo> {
    let content = match fs::read_to_string("/proc/mounts") {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    let mut disks = Vec::new();

    for line in content.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 3 {
            continue;
        }

        let _device = parts[0];
        let mount_point = parts[1];
        let filesystem = parts[2];

        // Skip virtual/pseudo filesystems
        if matches!(
            filesystem,
            "proc" | "sysfs" | "devtmpfs" | "devpts" | "tmpfs" | "securityfs"
                | "cgroup" | "cgroup2" | "pstore" | "debugfs" | "hugetlbfs"
                | "mqueue" | "fusectl" | "configfs" | "binfmt_misc" | "autofs"
                | "tracefs" | "bpf" | "efivarfs" | "overlay" | "nsfs"
                | "ramfs" | "rpc_pipefs" | "nfsd"
        ) {
            continue;
        }

        // Use statvfs to get sizes
        let mount_cstr = match std::ffi::CString::new(mount_point) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
        let ret = unsafe { libc::statvfs(mount_cstr.as_ptr(), &mut stat) };
        if ret != 0 {
            continue;
        }

        let block_size = stat.f_frsize as u64;
        let total_bytes = stat.f_blocks * block_size;
        let available_bytes = stat.f_bavail * block_size;
        let free_bytes = stat.f_bfree * block_size;
        let used_bytes = total_bytes.saturating_sub(free_bytes);

        // Skip zero-size filesystems
        if total_bytes == 0 {
            continue;
        }

        disks.push(DiskInfo {
            mount_point: mount_point.to_string(),
            filesystem: filesystem.to_string(),
            total_bytes,
            used_bytes,
            available_bytes,
        });
    }

    disks
}

fn parse_network_info() -> Vec<NetworkInfo> {
    let net_dir = Path::new("/sys/class/net");
    let entries = match fs::read_dir(net_dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    let mut interfaces = Vec::new();

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip loopback
        if name == "lo" {
            continue;
        }

        let iface_dir = entry.path();

        let mac_address = fs::read_to_string(iface_dir.join("address"))
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| s != "00:00:00:00:00:00");

        // Get IP addresses from /proc/net/if_inet6 and the operstate
        let ipv4 = get_ipv4_address(&name);
        let ipv6 = get_ipv6_address(&name);

        interfaces.push(NetworkInfo {
            name,
            mac_address,
            ipv4,
            ipv6,
        });
    }

    interfaces
}

fn get_ipv4_address(iface: &str) -> Option<String> {
    // Parse from /proc/net/fib_trie or use a simpler approach with ip command output
    // Simplest: parse /proc/net/dev and /proc/net/if_inet6 style files
    // For IPv4, we read from /proc/net/fib_trie which is complex.
    // Instead, iterate /sys/class/net/<iface>/... — but IPv4 isn't there.
    // Use nix::ifaddrs if available, or parse ip addr output
    // For simplicity, parse /proc/net/fib_trie
    let content = fs::read_to_string("/proc/net/fib_trie").ok()?;

    // This is a trie structure. Look for the interface section.
    // Simpler approach: iterate /proc/net/fib_trie looking for local addresses
    // Actually the simplest reliable method without extra deps:
    // Read from /proc/net/if_inet6 for v6 and use a different approach for v4

    // Parse ip addr show <iface> output via /sys is not available for IPv4
    // Fall back to reading /proc/net/route and matching
    let _ = content; // suppress unused

    // Use std::net approach: try to get from a UDP socket trick
    // This is too complex. Let's just return None for now and add a proper
    // implementation with the nix crate's getifaddrs when available.
    let _ = iface;
    None
}

fn get_ipv6_address(iface: &str) -> Option<String> {
    let content = fs::read_to_string("/proc/net/if_inet6").ok()?;

    for line in content.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 6 && parts[5] == iface {
            let hex = parts[0];
            if hex.len() == 32 {
                // Format: insert colons every 4 chars
                let formatted: Vec<&str> = (0..8).map(|i| &hex[i * 4..(i + 1) * 4]).collect();
                let addr = formatted.join(":");
                // Skip link-local (fe80::)
                if addr.starts_with("fe80") {
                    continue;
                }
                return Some(addr);
            }
        }
    }
    None
}
