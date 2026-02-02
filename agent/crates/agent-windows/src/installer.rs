//! Windows installer helpers: UAC elevation, explorer detection, and Win32 settings dialog.

#[cfg(target_os = "windows")]
use anyhow::{Context, Result};
#[cfg(target_os = "windows")]
use tracing::info;

/// Parameters collected from the install dialog or CLI.
#[derive(Debug, Clone)]
pub struct InstallParams {
    pub server_url: String,
    pub enroll_token: String,
    pub install_service: bool,
    pub start_service: bool,
}

// ── UAC Elevation ──────────────────────────────────────────────────────────

/// Check if the current process is running with elevated (admin) privileges.
#[cfg(target_os = "windows")]
pub fn is_elevated() -> bool {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }

        let mut elevation = TOKEN_ELEVATION::default();
        let mut ret_len = 0u32;
        let size = std::mem::size_of::<TOKEN_ELEVATION>() as u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut _),
            size,
            &mut ret_len,
        );
        let _ = CloseHandle(token);
        ok.is_ok() && elevation.TokenIsElevated != 0
    }
}

#[cfg(not(target_os = "windows"))]
pub fn is_elevated() -> bool {
    false
}

/// Re-launch the current process with "Run as Administrator" (UAC prompt).
/// This function does not return on success — the elevated child takes over.
#[cfg(target_os = "windows")]
pub fn relaunch_elevated(args: &str) -> Result<()> {
    use windows::Win32::UI::Shell::ShellExecuteExW;
    use windows::Win32::UI::Shell::SHELLEXECUTEINFOW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    use windows::core::PCWSTR;

    let exe = std::env::current_exe().context("failed to get current exe path")?;
    let exe_wide: Vec<u16> = exe
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let verb: Vec<u16> = "runas\0".encode_utf16().collect();
    let params: Vec<u16> = args.encode_utf16().chain(std::iter::once(0)).collect();

    let mut sei = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(exe_wide.as_ptr()),
        lpParameters: PCWSTR(params.as_ptr()),
        nShow: SW_SHOWNORMAL.0 as i32,
        ..Default::default()
    };

    unsafe {
        ShellExecuteExW(&mut sei).context("ShellExecuteExW (runas) failed")?;
    }

    info!("elevated process launched, exiting current process");
    std::process::exit(0);
}

#[cfg(not(target_os = "windows"))]
pub fn relaunch_elevated(_args: &str) -> Result<()> {
    anyhow::bail!("UAC elevation is only supported on Windows");
}

// ── Explorer Detection ─────────────────────────────────────────────────────

/// Returns true if the current process was launched by explorer.exe (double-click).
#[cfg(target_os = "windows")]
pub fn launched_from_explorer() -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW,
        PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::GetCurrentProcessId;

    unsafe {
        let my_pid = GetCurrentProcessId();
        let snap = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(h) => h,
            Err(_) => return false,
        };

        // Find our process entry to get the parent PID
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };

        let mut parent_pid = 0u32;
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                if entry.th32ProcessID == my_pid {
                    parent_pid = entry.th32ParentProcessID;
                    break;
                }
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }

        if parent_pid == 0 {
            let _ = CloseHandle(snap);
            return false;
        }

        // Now find the parent process name
        let mut entry2 = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut found = false;
        if Process32FirstW(snap, &mut entry2).is_ok() {
            loop {
                if entry2.th32ProcessID == parent_pid {
                    let name_end = entry2.szExeFile.iter()
                        .position(|&c| c == 0)
                        .unwrap_or(entry2.szExeFile.len().min(260));
                    let name = String::from_utf16_lossy(&entry2.szExeFile[..name_end]);
                    found = name.eq_ignore_ascii_case("explorer.exe");
                    break;
                }
                if Process32NextW(snap, &mut entry2).is_err() {
                    break;
                }
            }
        }

        let _ = CloseHandle(snap);
        found
    }
}

#[cfg(not(target_os = "windows"))]
pub fn launched_from_explorer() -> bool {
    false
}

// ── Win32 Settings Dialog ──────────────────────────────────────────────────

/// Show a native Win32 settings dialog and return the user's choices.
/// Returns `None` if the user clicked Cancel.
#[cfg(target_os = "windows")]
pub fn show_install_dialog() -> Option<InstallParams> {
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::*;
    use windows::core::PCWSTR;

    // Dialog control IDs
    const IDC_SERVER_URL: u16 = 101;
    const IDC_ENROLL_TOKEN: u16 = 102;
    const IDC_INSTALL_SERVICE: u16 = 103;
    const IDC_START_SERVICE: u16 = 104;
    const IDOK_BTN: u16 = 1;      // IDOK
    const IDCANCEL_BTN: u16 = 2;  // IDCANCEL

    thread_local! {
        static DIALOG_RESULT: std::cell::RefCell<Option<InstallParams>> = std::cell::RefCell::new(None);
    }

    /// Build an in-memory DLGTEMPLATE + items.
    fn build_dialog_template() -> Vec<u16> {
        let mut buf: Vec<u16> = Vec::new();

        // -- DLGTEMPLATE header --
        // style: DS_MODALFRAME | DS_CENTER | WS_POPUP | WS_CAPTION | WS_SYSMENU | DS_SETFONT
        let style: u32 = 0x80000000  // WS_POPUP
            | 0x00C00000             // WS_CAPTION
            | 0x00080000             // WS_SYSMENU
            | 0x00000080             // DS_MODALFRAME
            | 0x00000800             // DS_CENTER
            | 0x00000040;            // DS_SETFONT
        let ex_style: u32 = 0;
        let item_count: u16 = 10;
        let x: u16 = 0;
        let y: u16 = 0;
        let cx: u16 = 260;
        let cy: u16 = 170;

        buf.push(style as u16);
        buf.push((style >> 16) as u16);
        buf.push(ex_style as u16);
        buf.push((ex_style >> 16) as u16);
        buf.push(item_count);
        buf.push(x);
        buf.push(y);
        buf.push(cx);
        buf.push(cy);
        buf.push(0); // menu: none
        buf.push(0); // class: default
        push_wstr(&mut buf, "Android Remote Agent Setup");
        buf.push(9); // font point size
        push_wstr(&mut buf, "Segoe UI");

        fn align_dword(buf: &mut Vec<u16>) {
            while (buf.len() * 2) % 4 != 0 {
                buf.push(0);
            }
        }

        fn push_wstr(buf: &mut Vec<u16>, s: &str) {
            for c in s.encode_utf16() {
                buf.push(c);
            }
            buf.push(0);
        }

        fn add_item(
            buf: &mut Vec<u16>,
            style: u32,
            x: u16, y: u16, cx: u16, cy: u16,
            id: u16,
            class: u16,
            text: &str,
        ) {
            align_dword(buf);
            let ex_style: u32 = 0;
            buf.push(style as u16);
            buf.push((style >> 16) as u16);
            buf.push(ex_style as u16);
            buf.push((ex_style >> 16) as u16);
            buf.push(x);
            buf.push(y);
            buf.push(cx);
            buf.push(cy);
            buf.push(id);
            buf.push(0xFFFF);
            buf.push(class);
            push_wstr(buf, text);
            buf.push(0); // creation data length
        }

        // Title label
        add_item(&mut buf, 0x50000000,
            10, 8, 240, 12, 0xFFFF, 0x0082, "Configure your Android Remote Agent connection:");

        // "Server URL:" label
        add_item(&mut buf, 0x50000000,
            10, 28, 80, 10, 0xFFFF, 0x0082, "Server URL:");

        // Server URL edit
        add_item(&mut buf, 0x50810080,
            10, 40, 240, 14, IDC_SERVER_URL, 0x0081, "");

        // "Enrollment Token:" label
        add_item(&mut buf, 0x50000000,
            10, 60, 100, 10, 0xFFFF, 0x0082, "Enrollment Token:");

        // Token edit
        add_item(&mut buf, 0x50810080,
            10, 72, 240, 14, IDC_ENROLL_TOKEN, 0x0081, "");

        // "Install as Windows service" checkbox
        add_item(&mut buf, 0x50010003,
            10, 95, 200, 12, IDC_INSTALL_SERVICE, 0x0080, "Install as Windows service");

        // "Start service after install" checkbox
        add_item(&mut buf, 0x50010003,
            10, 110, 200, 12, IDC_START_SERVICE, 0x0080, "Start service after install");

        // Install button
        add_item(&mut buf, 0x50010001,
            140, 140, 55, 18, IDOK_BTN, 0x0080, "Install");

        // Cancel button
        add_item(&mut buf, 0x50010000,
            200, 140, 50, 18, IDCANCEL_BTN, 0x0080, "Cancel");

        buf
    }

    unsafe extern "system" fn dialog_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        _lparam: LPARAM,
    ) -> isize {
        const WM_INITDIALOG: u32 = 0x0110;
        const WM_COMMAND: u32 = 0x0111;
        const BM_SETCHECK: u32 = 0x00F1;
        const BST_CHECKED: u32 = 1;
        const IDC_INSTALL_SERVICE: i32 = 103;
        const IDC_START_SERVICE: i32 = 104;

        match msg {
            WM_INITDIALOG => {
                // Check both checkboxes by default
                if let Ok(h) = GetDlgItem(hwnd, IDC_INSTALL_SERVICE) {
                    SendMessageW(h, BM_SETCHECK, WPARAM(BST_CHECKED as usize), LPARAM(0));
                }
                if let Ok(h) = GetDlgItem(hwnd, IDC_START_SERVICE) {
                    SendMessageW(h, BM_SETCHECK, WPARAM(BST_CHECKED as usize), LPARAM(0));
                }
                return 1; // set default focus
            }
            WM_COMMAND => {
                let id = (wparam.0 & 0xFFFF) as u16;
                match id {
                    1 => {
                        // IDOK — Install clicked
                        let server_url = get_dlg_item_text(hwnd, 101);
                        let enroll_token = get_dlg_item_text(hwnd, 102);

                        // Validate server URL
                        let url_trimmed = server_url.trim();
                        if url_trimmed.is_empty()
                            || !(url_trimmed.starts_with("http://")
                                || url_trimmed.starts_with("https://")
                                || url_trimmed.starts_with("ws://")
                                || url_trimmed.starts_with("wss://"))
                        {
                            let msg_text: Vec<u16> = "Server URL must start with http://, https://, ws://, or wss://\0"
                                .encode_utf16().collect();
                            let title: Vec<u16> = "Validation Error\0".encode_utf16().collect();
                            MessageBoxW(
                                hwnd,
                                PCWSTR(msg_text.as_ptr()),
                                PCWSTR(title.as_ptr()),
                                MB_ICONWARNING | MB_OK,
                            );
                            return 1;
                        }

                        if enroll_token.trim().is_empty() {
                            let msg_text: Vec<u16> = "Enrollment token is required.\0"
                                .encode_utf16().collect();
                            let title: Vec<u16> = "Validation Error\0".encode_utf16().collect();
                            MessageBoxW(
                                hwnd,
                                PCWSTR(msg_text.as_ptr()),
                                PCWSTR(title.as_ptr()),
                                MB_ICONWARNING | MB_OK,
                            );
                            return 1;
                        }

                        let install_service = is_checkbox_checked(hwnd, 103);
                        let start_service = is_checkbox_checked(hwnd, 104);

                        DIALOG_RESULT.with(|r| {
                            *r.borrow_mut() = Some(InstallParams {
                                server_url: url_trimmed.to_string(),
                                enroll_token: enroll_token.trim().to_string(),
                                install_service,
                                start_service,
                            });
                        });

                        let _ = EndDialog(hwnd, 1);
                        return 1;
                    }
                    2 => {
                        // IDCANCEL
                        let _ = EndDialog(hwnd, 0);
                        return 1;
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        0
    }

    unsafe fn get_dlg_item_text(hwnd: HWND, id: i32) -> String {
        let ctrl = match GetDlgItem(hwnd, id) {
            Ok(h) => h,
            Err(_) => return String::new(),
        };
        let len = GetWindowTextLengthW(ctrl) as usize;
        if len == 0 {
            return String::new();
        }
        let mut buf = vec![0u16; len + 1];
        GetWindowTextW(ctrl, &mut buf);
        String::from_utf16_lossy(&buf[..len])
    }

    unsafe fn is_checkbox_checked(hwnd: HWND, id: i32) -> bool {
        let ctrl = match GetDlgItem(hwnd, id) {
            Ok(h) => h,
            Err(_) => return false,
        };
        const BM_GETCHECK: u32 = 0x00F0;
        SendMessageW(ctrl, BM_GETCHECK, WPARAM(0), LPARAM(0)).0 != 0
    }

    let template = build_dialog_template();
    let dlg_template_ptr = template.as_ptr() as *const DLGTEMPLATE;

    let ret = unsafe {
        DialogBoxIndirectParamW(
            None,
            dlg_template_ptr,
            HWND::default(),
            Some(dialog_proc),
            LPARAM(0),
        )
    };

    if ret == 1 {
        DIALOG_RESULT.with(|r| r.borrow_mut().take())
    } else {
        None
    }
}

#[cfg(not(target_os = "windows"))]
pub fn show_install_dialog() -> Option<InstallParams> {
    None
}

/// Show a native Windows MessageBox (used for success/error feedback).
#[cfg(target_os = "windows")]
pub fn show_message_box(title: &str, message: &str, is_error: bool) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::*;
    use windows::core::PCWSTR;

    let title_w: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
    let msg_w: Vec<u16> = message.encode_utf16().chain(std::iter::once(0)).collect();
    let flags = if is_error { MB_ICONERROR | MB_OK } else { MB_ICONINFORMATION | MB_OK };

    unsafe {
        MessageBoxW(HWND::default(), PCWSTR(msg_w.as_ptr()), PCWSTR(title_w.as_ptr()), flags);
    }
}

#[cfg(not(target_os = "windows"))]
pub fn show_message_box(_title: &str, _message: &str, _is_error: bool) {}
