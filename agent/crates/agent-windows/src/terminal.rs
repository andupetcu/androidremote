use agent_platform::terminal::Terminal;
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use tracing::{debug, info};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Console::{
    ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON,
};
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::Threading::{
    CreateProcessW, GetExitCodeProcess, InitializeProcThreadAttributeList,
    UpdateProcThreadAttribute, EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROCESS_INFORMATION, STARTUPINFOEXW,
};
use windows::core::PWSTR;

/// Windows terminal implementation using ConPTY (Pseudo Console)
pub struct WindowsTerminal {
    hpc: Option<HPCON>,
    pipe_in: Option<OwnedHandle>,  // write end → goes to PTY stdin
    pipe_out: Option<OwnedHandle>, // read end → comes from PTY stdout
    process: Option<PROCESS_INFORMATION>,
}

impl WindowsTerminal {
    pub fn new() -> Self {
        Self {
            hpc: None,
            pipe_in: None,
            pipe_out: None,
            process: None,
        }
    }

    fn detect_shell() -> String {
        // Prefer PowerShell, fall back to cmd.exe
        if let Ok(ps) = std::env::var("COMSPEC") {
            // COMSPEC is usually cmd.exe, but use it as fallback
            let _ = ps;
        }
        // Check for PowerShell 7+
        if std::path::Path::new("C:\\Program Files\\PowerShell\\7\\pwsh.exe").exists() {
            return "C:\\Program Files\\PowerShell\\7\\pwsh.exe".to_string();
        }
        // Windows PowerShell 5.1
        let ps_path = format!(
            "{}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string())
        );
        if std::path::Path::new(&ps_path).exists() {
            return ps_path;
        }
        // Fallback to cmd.exe
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
}

#[async_trait]
impl Terminal for WindowsTerminal {
    async fn spawn(&mut self, shell: Option<&str>, cols: u16, rows: u16) -> Result<()> {
        let shell_path = shell
            .map(String::from)
            .unwrap_or_else(Self::detect_shell);

        info!(
            "spawning terminal: shell={}, cols={}, rows={}",
            shell_path, cols, rows
        );

        unsafe {
            // Create pipes for PTY I/O
            let mut pty_input_read = HANDLE::default();
            let mut pty_input_write = HANDLE::default();
            let mut pty_output_read = HANDLE::default();
            let mut pty_output_write = HANDLE::default();

            CreatePipe(&mut pty_input_read, &mut pty_input_write, None, 0)
                .context("CreatePipe for PTY input")?;
            CreatePipe(&mut pty_output_read, &mut pty_output_write, None, 0)
                .context("CreatePipe for PTY output")?;

            // Create the pseudo console
            let size = COORD {
                X: cols as i16,
                Y: rows as i16,
            };
            let mut hpc = HPCON::default();
            CreatePseudoConsole(size, pty_input_read, pty_output_write, 0, &mut hpc)
                .context("CreatePseudoConsole")?;

            // Close the pipe ends that the PTY owns
            let _ = CloseHandle(pty_input_read);
            let _ = CloseHandle(pty_output_write);

            // Set up startup info with the pseudo console
            let mut attr_list_size: usize = 0;
            let _ = InitializeProcThreadAttributeList(
                LPPROC_THREAD_ATTRIBUTE_LIST::default(),
                1,
                0,
                &mut attr_list_size,
            );

            let mut attr_list_buf = vec![0u8; attr_list_size];
            let attr_list =
                LPPROC_THREAD_ATTRIBUTE_LIST(attr_list_buf.as_mut_ptr() as *mut _);

            InitializeProcThreadAttributeList(attr_list, 1, 0, &mut attr_list_size)
                .context("InitializeProcThreadAttributeList")?;

            // PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016
            const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: usize = 0x00020016;
            UpdateProcThreadAttribute(
                attr_list,
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                Some(hpc.0 as *const std::ffi::c_void),
                std::mem::size_of::<HPCON>(),
                None,
                None,
            )
            .context("UpdateProcThreadAttribute")?;

            let mut si = STARTUPINFOEXW::default();
            si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
            si.lpAttributeList = attr_list;

            let mut pi = PROCESS_INFORMATION::default();

            // Create the shell command line as wide string
            let mut cmd_line: Vec<u16> = shell_path.encode_utf16().collect();
            cmd_line.push(0);

            CreateProcessW(
                None,
                PWSTR(cmd_line.as_mut_ptr()),
                None,
                None,
                false,
                EXTENDED_STARTUPINFO_PRESENT,
                None,
                None,
                &si.StartupInfo,
                &mut pi,
            )
            .context("CreateProcessW")?;

            self.hpc = Some(hpc);
            self.pipe_in = Some(OwnedHandle::from_raw_handle(pty_input_write.0 as *mut _));
            self.pipe_out = Some(OwnedHandle::from_raw_handle(pty_output_read.0 as *mut _));
            self.process = Some(pi);

            info!(
                "terminal spawned: pid={}, shell={}",
                pi.dwProcessId, shell_path
            );
        }

        Ok(())
    }

    async fn write_stdin(&mut self, data: &[u8]) -> Result<()> {
        let handle = self.pipe_in.as_ref().context("terminal not spawned")?;
        let raw = HANDLE(handle.as_raw_handle() as isize);

        unsafe {
            let mut written: u32 = 0;
            windows::Win32::Storage::FileSystem::WriteFile(
                raw,
                Some(data),
                Some(&mut written),
                None,
            )
            .context("WriteFile to PTY")?;
        }

        Ok(())
    }

    async fn read_stdout(&mut self) -> Result<Vec<u8>> {
        let handle = self.pipe_out.as_ref().context("terminal not spawned")?;
        let raw = HANDLE(handle.as_raw_handle() as isize);

        let mut buf = vec![0u8; 4096];
        let mut bytes_read: u32 = 0;

        // Check if data is available (non-blocking peek)
        let mut bytes_available: u32 = 0;
        unsafe {
            let peek_ok = windows::Win32::System::Pipes::PeekNamedPipe(
                raw,
                None,
                0,
                None,
                Some(&mut bytes_available),
                None,
            );
            if peek_ok.is_err() || bytes_available == 0 {
                // No data available — yield and return empty
                tokio::task::yield_now().await;
                return Ok(vec![]);
            }

            windows::Win32::Storage::FileSystem::ReadFile(
                raw,
                Some(&mut buf),
                Some(&mut bytes_read),
                None,
            )
            .context("ReadFile from PTY")?;
        }

        buf.truncate(bytes_read as usize);
        Ok(buf)
    }

    async fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        let hpc = self.hpc.as_ref().context("terminal not spawned")?;

        let size = COORD {
            X: cols as i16,
            Y: rows as i16,
        };

        unsafe {
            ResizePseudoConsole(*hpc, size).context("ResizePseudoConsole")?;
        }

        debug!("terminal resized to {}x{}", cols, rows);
        Ok(())
    }

    fn is_alive(&self) -> bool {
        if let Some(pi) = &self.process {
            unsafe {
                let mut exit_code: u32 = 0;
                if GetExitCodeProcess(pi.hProcess, &mut exit_code).is_ok() {
                    // STILL_ACTIVE = 259
                    return exit_code == 259;
                }
            }
        }
        false
    }
}

impl Drop for WindowsTerminal {
    fn drop(&mut self) {
        // Close the pseudo console
        if let Some(hpc) = self.hpc.take() {
            unsafe {
                ClosePseudoConsole(hpc);
            }
        }

        // Close process handles
        if let Some(pi) = self.process.take() {
            unsafe {
                // Terminate the process if still running
                let mut exit_code: u32 = 0;
                if GetExitCodeProcess(pi.hProcess, &mut exit_code).is_ok() && exit_code == 259 {
                    let _ = windows::Win32::System::Threading::TerminateProcess(pi.hProcess, 1);
                }
                let _ = CloseHandle(pi.hProcess);
                let _ = CloseHandle(pi.hThread);
            }
        }

        // pipe_in and pipe_out are OwnedHandle, dropped automatically
    }
}
