// Helper process launcher — spawns the helper in an interactive user session.
//
// Used by the service process (Session 0) to create a helper process
// in the active console session via Windows Terminal Services APIs.

#[cfg(target_os = "windows")]
use anyhow::{bail, Context, Result};
#[cfg(target_os = "windows")]
use tracing::{error, info, warn};

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{
    CloseHandle, HANDLE, BOOL, WAIT_OBJECT_0,
};
#[cfg(target_os = "windows")]
use windows::Win32::Security::TOKEN_ALL_ACCESS;
#[cfg(target_os = "windows")]
use windows::Win32::System::RemoteDesktop::WTSQueryUserToken;
#[cfg(target_os = "windows")]
use windows::Win32::System::Threading::{
    CreateProcessAsUserW, GetExitCodeProcess, TerminateProcess,
    WaitForSingleObject,
    CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT,
    PROCESS_INFORMATION, STARTUPINFOW,
};
#[cfg(target_os = "windows")]
use windows::core::PCWSTR;

// FFI for DuplicateTokenEx (may not be directly exposed in all windows crate builds)
#[cfg(target_os = "windows")]
use windows::Win32::Security::{
    DuplicateTokenEx, SecurityIdentification, TokenPrimary,
};

// FFI for CreateEnvironmentBlock / DestroyEnvironmentBlock
#[cfg(target_os = "windows")]
extern "system" {
    fn CreateEnvironmentBlock(
        lpEnvironment: *mut *mut std::ffi::c_void,
        hToken: HANDLE,
        bInherit: BOOL,
    ) -> BOOL;
    fn DestroyEnvironmentBlock(lpEnvironment: *const std::ffi::c_void) -> BOOL;
}

#[cfg(target_os = "windows")]
fn to_wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// Manages the lifecycle of a helper process spawned in a user session.
#[cfg(target_os = "windows")]
pub struct HelperLauncher {
    exe_path: String,
    pipe_name: String,
    process_handle: Option<HANDLE>,
    thread_handle: Option<HANDLE>,
    session_id: u32,
}

#[cfg(target_os = "windows")]
unsafe impl Send for HelperLauncher {}
#[cfg(target_os = "windows")]
unsafe impl Sync for HelperLauncher {}

#[cfg(target_os = "windows")]
impl HelperLauncher {
    pub fn new(exe_path: String, pipe_name: String) -> Self {
        Self {
            exe_path,
            pipe_name,
            process_handle: None,
            thread_handle: None,
            session_id: 0,
        }
    }

    /// Spawn the helper process in the specified user session.
    ///
    /// Uses WTSQueryUserToken → DuplicateTokenEx → CreateEnvironmentBlock
    /// → CreateProcessAsUserW to launch the helper binary on the user's desktop.
    pub fn spawn_in_session(&mut self, session_id: u32) -> Result<()> {
        // Clean up any existing process
        self.kill_if_alive();

        info!(
            "launching helper in session {} (exe={}, pipe={})",
            session_id, self.exe_path, self.pipe_name
        );

        unsafe {
            // 1. Get user token for the target session
            let mut user_token = HANDLE::default();
            WTSQueryUserToken(session_id, &mut user_token)
                .context("WTSQueryUserToken failed — is the service running as SYSTEM?")?;

            // 2. Duplicate as primary token
            let mut dup_token = HANDLE::default();
            let dup_result = DuplicateTokenEx(
                user_token,
                TOKEN_ALL_ACCESS,
                None,
                SecurityIdentification,
                TokenPrimary,
                &mut dup_token,
            );

            let _ = CloseHandle(user_token);

            if dup_result.is_err() {
                bail!("DuplicateTokenEx failed: {:?}", dup_result.err());
            }

            // 3. Create environment block for the user
            let mut env_block: *mut std::ffi::c_void = std::ptr::null_mut();
            let env_result = CreateEnvironmentBlock(&mut env_block, dup_token, BOOL(0));
            if env_result == BOOL(0) {
                let _ = CloseHandle(dup_token);
                bail!("CreateEnvironmentBlock failed");
            }

            // 4. Build command line
            let cmd_line = format!(
                "\"{}\" --helper-mode --pipe-name \"{}\" --log-level info",
                self.exe_path, self.pipe_name
            );
            let mut cmd_wide = to_wide(&cmd_line);

            // 5. Set up STARTUPINFOW with winsta0\default desktop
            let desktop = to_wide("winsta0\\default");
            let mut startup_info = STARTUPINFOW::default();
            startup_info.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
            startup_info.lpDesktop = windows::core::PWSTR(desktop.as_ptr() as *mut u16);

            let mut process_info = PROCESS_INFORMATION::default();

            // 6. Create the process in the user's session
            let create_result = CreateProcessAsUserW(
                dup_token,
                None,
                PCWSTR(cmd_wide.as_mut_ptr()),
                None, // process security attributes
                None, // thread security attributes
                false,
                CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                Some(env_block),
                None, // current directory (inherit)
                &startup_info,
                &mut process_info,
            );

            // 7. Cleanup
            DestroyEnvironmentBlock(env_block);
            let _ = CloseHandle(dup_token);

            if create_result.is_err() {
                bail!("CreateProcessAsUserW failed: {:?}", create_result.err());
            }

            info!(
                "helper process launched: pid={}, session={}",
                process_info.dwProcessId, session_id
            );

            self.process_handle = Some(process_info.hProcess);
            self.thread_handle = Some(process_info.hThread);
            self.session_id = session_id;
        }

        Ok(())
    }

    /// Check if the helper process is still running.
    pub fn is_alive(&self) -> bool {
        if let Some(handle) = self.process_handle {
            unsafe {
                let mut exit_code: u32 = 0;
                if GetExitCodeProcess(handle, &mut exit_code).is_ok() {
                    // STILL_ACTIVE = 259
                    return exit_code == 259;
                }
            }
        }
        false
    }

    /// Kill the helper process if it's running.
    pub fn kill(&mut self) -> Result<()> {
        self.kill_if_alive();
        Ok(())
    }

    /// Kill and respawn the helper in the same session.
    pub fn respawn(&mut self) -> Result<()> {
        let session = self.session_id;
        self.kill_if_alive();
        self.spawn_in_session(session)
    }

    /// Get the session ID the helper was spawned in.
    pub fn session_id(&self) -> u32 {
        self.session_id
    }

    fn kill_if_alive(&mut self) {
        if let Some(handle) = self.process_handle.take() {
            unsafe {
                // Try graceful check first
                let mut exit_code: u32 = 0;
                if GetExitCodeProcess(handle, &mut exit_code).is_ok() && exit_code == 259 {
                    info!("terminating existing helper process");
                    let _ = TerminateProcess(handle, 1);
                    // Wait briefly for it to die
                    let _ = WaitForSingleObject(handle, 3000);
                }
                let _ = CloseHandle(handle);
            }
        }
        if let Some(handle) = self.thread_handle.take() {
            unsafe {
                let _ = CloseHandle(handle);
            }
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for HelperLauncher {
    fn drop(&mut self) {
        self.kill_if_alive();
    }
}
