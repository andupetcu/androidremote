// Windows session detection utilities
//
// Determines whether the agent is running in an interactive user session
// or in Session 0 (SYSTEM service context), which has no desktop access.

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{CloseHandle, HANDLE, BOOL};
#[cfg(target_os = "windows")]
use windows::Win32::System::RemoteDesktop::{
    WTSGetActiveConsoleSessionId,
};
#[cfg(target_os = "windows")]
use windows::Win32::System::StationsAndDesktops::OpenInputDesktop;
#[cfg(target_os = "windows")]
use windows::Win32::System::Threading::GetCurrentProcessId;

#[cfg(target_os = "windows")]
use tracing::{debug, warn};

/// Returns the session ID of the current process.
///
/// Session 0 = SYSTEM service context (no desktop).
/// Session 1+ = interactive user session.
#[cfg(target_os = "windows")]
pub fn current_session_id() -> u32 {
    unsafe {
        let pid = GetCurrentProcessId();
        let mut session_id: u32 = 0;
        // ProcessIdToSessionId is in kernel32, use windows-sys style or direct FFI
        let result = ProcessIdToSessionId(pid, &mut session_id);
        if result == false {
            warn!("ProcessIdToSessionId failed, assuming session 0");
            return 0;
        }
        session_id
    }
}

/// FFI binding for ProcessIdToSessionId (not always in the windows crate features)
#[cfg(target_os = "windows")]
extern "system" {
    fn ProcessIdToSessionId(dwProcessId: u32, pSessionId: *mut u32) -> BOOL;
}

/// Returns true if the current process is in an interactive session
/// (session > 0 AND can open the input desktop).
#[cfg(target_os = "windows")]
pub fn is_interactive_session() -> bool {
    let session_id = current_session_id();
    if session_id == 0 {
        return false;
    }

    // Try to open the input desktop as a definitive test
    unsafe {
        use windows::Win32::System::StationsAndDesktops::DESKTOP_ACCESS_FLAGS;
        match OpenInputDesktop(
            windows::Win32::System::StationsAndDesktops::DF_ALLOWOTHERACCOUNTHOOK,
            false,
            DESKTOP_ACCESS_FLAGS(0),
        ) {
            Ok(desktop) => {
                let _ = CloseHandle(HANDLE(desktop.0));
                true
            }
            Err(e) => {
                debug!("OpenInputDesktop failed (session {}): {}", session_id, e);
                false
            }
        }
    }
}

/// Returns true if the process is running as a Session 0 system service.
#[cfg(target_os = "windows")]
pub fn is_system_service_context() -> bool {
    current_session_id() == 0
}

/// Returns the session ID of the active console (physical monitor) session,
/// or None if no user is logged in (returns 0xFFFFFFFF).
#[cfg(target_os = "windows")]
pub fn get_active_console_session() -> Option<u32> {
    unsafe {
        let session_id = WTSGetActiveConsoleSessionId();
        if session_id == 0xFFFFFFFF {
            None
        } else {
            Some(session_id)
        }
    }
}

/// Log the current session context for diagnostic purposes.
#[cfg(target_os = "windows")]
pub fn log_session_info() {
    let session_id = current_session_id();
    let interactive = is_interactive_session();
    let console_session = get_active_console_session();

    tracing::info!(
        session_id = session_id,
        interactive = interactive,
        console_session = ?console_session,
        "windows session detection: session_id={}, interactive={}, console_session={:?}",
        session_id,
        interactive,
        console_session,
    );

    if is_system_service_context() {
        tracing::warn!(
            "running in Session 0 (SYSTEM service context) — \
             desktop capture and input injection require helper process in user session"
        );
    }
}
