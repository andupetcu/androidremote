use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;

use agent_platform::system_info::{CpuInfo, DiskInfo, MemoryInfo, NetworkInfo, SystemInfo};
use windows::Win32::System::SystemInformation::{
    GetSystemInfo, GlobalMemoryStatusEx, MEMORYSTATUSEX, SYSTEM_INFO,
};

pub struct WindowsSystemInfo;

impl WindowsSystemInfo {
    pub fn new() -> Self {
        Self
    }
}

impl SystemInfo for WindowsSystemInfo {
    fn hostname(&self) -> String {
        // Use Rust std approach for hostname
        hostname_string().unwrap_or_else(|| "unknown".to_string())
    }

    fn os_name(&self) -> String {
        "windows".to_string()
    }

    fn os_version(&self) -> String {
        read_os_version().unwrap_or_else(|| "Windows".to_string())
    }

    fn arch(&self) -> String {
        std::env::consts::ARCH.to_string()
    }

    fn cpu_info(&self) -> CpuInfo {
        let model = read_cpu_model().unwrap_or_else(|| "Unknown CPU".to_string());
        let (cores, threads) = read_cpu_count();
        let usage_percent = read_cpu_usage();

        CpuInfo {
            model,
            cores,
            threads,
            usage_percent,
        }
    }

    fn memory_info(&self) -> MemoryInfo {
        read_memory_info().unwrap_or(MemoryInfo {
            total_bytes: 0,
            used_bytes: 0,
            available_bytes: 0,
        })
    }

    fn disk_info(&self) -> Vec<DiskInfo> {
        read_disk_info()
    }

    fn network_interfaces(&self) -> Vec<NetworkInfo> {
        read_network_info()
    }
}

fn hostname_string() -> Option<String> {
    // Use GetComputerNameW
    use windows::Win32::System::SystemInformation::GetComputerNameExW;
    use windows::Win32::System::SystemInformation::COMPUTER_NAME_FORMAT;

    let mut size: u32 = 0;
    // First call to get required size
    unsafe {
        let _ = GetComputerNameExW(
            COMPUTER_NAME_FORMAT(1), // ComputerNameDnsHostname
            windows::core::PWSTR::null(),
            &mut size,
        );
    }
    if size == 0 {
        return None;
    }

    let mut buf = vec![0u16; size as usize];
    unsafe {
        GetComputerNameExW(
            COMPUTER_NAME_FORMAT(1),
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut size,
        )
        .ok()?;
    }

    buf.truncate(size as usize);
    Some(OsString::from_wide(&buf).to_string_lossy().to_string())
}

fn read_os_version() -> Option<String> {
    // Read from registry: HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion
    use windows::Win32::System::Registry::{
        RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ, REG_SZ,
    };
    use windows::core::PCWSTR;

    let subkey: Vec<u16> = "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\0"
        .encode_utf16()
        .collect();
    let product_name: Vec<u16> = "ProductName\0".encode_utf16().collect();
    let display_version: Vec<u16> = "DisplayVersion\0".encode_utf16().collect();

    unsafe {
        let mut hkey = HKEY::default();
        let status = RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(subkey.as_ptr()),
            0,
            KEY_READ,
            &mut hkey,
        );
        if status.is_err() {
            return None;
        }

        let name = read_reg_string(hkey, &product_name)?;
        let version = read_reg_string(hkey, &display_version).unwrap_or_default();

        let _ = windows::Win32::System::Registry::RegCloseKey(hkey);

        if version.is_empty() {
            Some(name)
        } else {
            Some(format!("{} ({})", name, version))
        }
    }
}

unsafe fn read_reg_string(hkey: windows::Win32::System::Registry::HKEY, value_name: &[u16]) -> Option<String> {
    use windows::Win32::System::Registry::RegQueryValueExW;
    use windows::core::PCWSTR;

    let mut data_type = windows::Win32::System::Registry::REG_VALUE_TYPE::default();
    let mut size: u32 = 0;

    // Query size
    let _ = RegQueryValueExW(
        hkey,
        PCWSTR(value_name.as_ptr()),
        None,
        Some(&mut data_type),
        None,
        Some(&mut size),
    );

    if size == 0 {
        return None;
    }

    let mut buf = vec![0u8; size as usize];
    let status = RegQueryValueExW(
        hkey,
        PCWSTR(value_name.as_ptr()),
        None,
        Some(&mut data_type),
        Some(buf.as_mut_ptr()),
        Some(&mut size),
    );
    if status.is_err() {
        return None;
    }

    // Convert from wide string (REG_SZ is null-terminated UTF-16)
    let wide: &[u16] = std::slice::from_raw_parts(buf.as_ptr() as *const u16, size as usize / 2);
    // Trim trailing null
    let len = wide.iter().position(|&c| c == 0).unwrap_or(wide.len());
    Some(OsString::from_wide(&wide[..len]).to_string_lossy().to_string())
}

fn read_cpu_model() -> Option<String> {
    // Read from registry: HKLM\HARDWARE\DESCRIPTION\System\CentralProcessor\0
    use windows::Win32::System::Registry::{
        RegOpenKeyExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ,
    };
    use windows::core::PCWSTR;

    let subkey: Vec<u16> = "HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0\0"
        .encode_utf16()
        .collect();
    let value_name: Vec<u16> = "ProcessorNameString\0".encode_utf16().collect();

    unsafe {
        let mut hkey = HKEY::default();
        let status = RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(subkey.as_ptr()),
            0,
            KEY_READ,
            &mut hkey,
        );
        if status.is_err() {
            return None;
        }

        let name = read_reg_string(hkey, &value_name);
        let _ = windows::Win32::System::Registry::RegCloseKey(hkey);
        name.map(|s| s.trim().to_string())
    }
}

fn read_cpu_count() -> (u32, u32) {
    unsafe {
        let mut info = SYSTEM_INFO::default();
        GetSystemInfo(&mut info);

        let threads = info.dwNumberOfProcessors;

        // For cores, we'd need GetLogicalProcessorInformation, but for simplicity
        // approximate as threads (most common case is 1:1 or 2:1 HT ratio)
        // A more accurate implementation can be added later
        let cores = threads;

        (cores.max(1), threads.max(1))
    }
}

fn read_cpu_usage() -> f64 {
    // Use GetSystemTimes for a snapshot-based CPU usage
    // This gives total/idle since boot, so a single sample gives cumulative average.
    // For real-time usage, two samples with a delay would be needed.
    use windows::Win32::System::Threading::GetSystemTimes;

    unsafe {
        let mut idle = windows::Win32::Foundation::FILETIME::default();
        let mut kernel = windows::Win32::Foundation::FILETIME::default();
        let mut user = windows::Win32::Foundation::FILETIME::default();

        if GetSystemTimes(
            Some(&mut idle),
            Some(&mut kernel),
            Some(&mut user),
        )
        .is_err()
        {
            return 0.0;
        }

        let idle_val = filetime_to_u64(&idle);
        let kernel_val = filetime_to_u64(&kernel);
        let user_val = filetime_to_u64(&user);

        let total = kernel_val + user_val;
        let busy = total - idle_val;

        if total == 0 {
            return 0.0;
        }

        (busy as f64 / total as f64) * 100.0
    }
}

fn filetime_to_u64(ft: &windows::Win32::Foundation::FILETIME) -> u64 {
    ((ft.dwHighDateTime as u64) << 32) | (ft.dwLowDateTime as u64)
}

fn read_memory_info() -> Option<MemoryInfo> {
    unsafe {
        let mut status = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        GlobalMemoryStatusEx(&mut status).ok()?;

        let total = status.ullTotalPhys;
        let available = status.ullAvailPhys;
        let used = total.saturating_sub(available);

        Some(MemoryInfo {
            total_bytes: total,
            used_bytes: used,
            available_bytes: available,
        })
    }
}

fn read_disk_info() -> Vec<DiskInfo> {
    use windows::Win32::Storage::FileSystem::GetLogicalDriveStringsW;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    use windows::Win32::Storage::FileSystem::GetVolumeInformationW;
    use windows::core::PCWSTR;

    let mut buf = [0u16; 512];
    let len = unsafe { GetLogicalDriveStringsW(Some(&mut buf)) } as usize;
    if len == 0 {
        return Vec::new();
    }

    let mut disks = Vec::new();
    let drive_strings = &buf[..len];

    // Drive strings are null-separated, double-null terminated
    for drive in drive_strings.split(|&c| c == 0) {
        if drive.is_empty() {
            continue;
        }

        let drive_path = OsString::from_wide(drive).to_string_lossy().to_string();

        // Get free space
        let mut free_bytes_available: u64 = 0;
        let mut total_bytes: u64 = 0;
        let mut total_free_bytes: u64 = 0;

        // Need null-terminated wide string
        let mut wide_path: Vec<u16> = drive.to_vec();
        if !wide_path.ends_with(&[0]) {
            wide_path.push(0);
        }

        let ok = unsafe {
            GetDiskFreeSpaceExW(
                PCWSTR(wide_path.as_ptr()),
                Some(&mut free_bytes_available),
                Some(&mut total_bytes),
                Some(&mut total_free_bytes),
            )
        };

        if ok.is_err() || total_bytes == 0 {
            continue;
        }

        // Get filesystem type
        let mut fs_name = [0u16; 64];
        let fs_ok = unsafe {
            GetVolumeInformationW(
                PCWSTR(wide_path.as_ptr()),
                None,
                None,
                None,
                None,
                Some(&mut fs_name),
            )
        };

        let filesystem = if fs_ok.is_ok() {
            let fs_len = fs_name.iter().position(|&c| c == 0).unwrap_or(fs_name.len());
            OsString::from_wide(&fs_name[..fs_len]).to_string_lossy().to_string()
        } else {
            "unknown".to_string()
        };

        let used_bytes = total_bytes.saturating_sub(total_free_bytes);

        disks.push(DiskInfo {
            mount_point: drive_path,
            filesystem,
            total_bytes,
            used_bytes,
            available_bytes: free_bytes_available,
        });
    }

    disks
}

fn read_network_info() -> Vec<NetworkInfo> {
    // For a robust implementation, we'd use GetAdaptersAddresses from iphlpapi.
    // This requires the Win32_NetworkManagement_IpHelper feature.
    // For now, provide a basic implementation that detects interfaces.
    // Full implementation can be added when the feature is available.

    // Fallback: use std::process::Command to parse ipconfig output
    let output = match std::process::Command::new("ipconfig")
        .arg("/all")
        .output()
    {
        Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
        Err(_) => return Vec::new(),
    };

    let mut interfaces = Vec::new();
    let mut current_name: Option<String> = None;
    let mut current_mac: Option<String> = None;
    let mut current_ipv4: Option<String> = None;
    let mut current_ipv6: Option<String> = None;

    for line in output.lines() {
        let trimmed = line.trim();

        // New adapter section (non-indented line ending with :)
        if !line.starts_with(' ') && line.ends_with(':') {
            // Save previous interface
            if let Some(name) = current_name.take() {
                interfaces.push(NetworkInfo {
                    name,
                    mac_address: current_mac.take(),
                    ipv4: current_ipv4.take(),
                    ipv6: current_ipv6.take(),
                });
            }
            current_name = Some(trimmed.trim_end_matches(':').to_string());
            current_mac = None;
            current_ipv4 = None;
            current_ipv6 = None;
            continue;
        }

        if let Some((key, value)) = trimmed.split_once(':') {
            let key = key.trim().trim_start_matches(". ");
            let value = value.trim();
            if value.is_empty() {
                continue;
            }

            if key.contains("Physical Address") {
                current_mac = Some(value.replace('-', ":").to_lowercase());
            } else if key.contains("IPv4 Address") {
                // Remove "(Preferred)" suffix
                current_ipv4 = Some(
                    value
                        .trim_end_matches("(Preferred)")
                        .trim()
                        .to_string(),
                );
            } else if key.contains("IPv6 Address") || key.contains("Link-local IPv6") {
                if current_ipv6.is_none() {
                    // Remove %scope_id suffix
                    let addr = value.split('%').next().unwrap_or(value);
                    current_ipv6 = Some(addr.to_string());
                }
            }
        }
    }

    // Save last interface
    if let Some(name) = current_name {
        interfaces.push(NetworkInfo {
            name,
            mac_address: current_mac,
            ipv4: current_ipv4,
            ipv6: current_ipv6,
        });
    }

    // Filter out disconnected interfaces (no IPs at all)
    interfaces
        .into_iter()
        .filter(|i| i.ipv4.is_some() || i.ipv6.is_some())
        .collect()
}
