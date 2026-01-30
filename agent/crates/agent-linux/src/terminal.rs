use agent_platform::terminal::Terminal;
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::process::Command;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tracing::{debug, info};

/// Linux terminal implementation using PTY via nix crate
pub struct LinuxTerminal {
    master_fd: Option<OwnedFd>,
    master_read: Option<tokio::io::unix::AsyncFd<std::os::fd::RawFd>>,
    child_pid: Option<nix::unistd::Pid>,
}

impl LinuxTerminal {
    pub fn new() -> Self {
        Self {
            master_fd: None,
            master_read: None,
            child_pid: None,
        }
    }

    fn detect_shell() -> String {
        // Try $SHELL, then common paths
        if let Ok(shell) = std::env::var("SHELL") {
            if std::path::Path::new(&shell).exists() {
                return shell;
            }
        }
        for path in &["/bin/bash", "/usr/bin/bash", "/bin/sh"] {
            if std::path::Path::new(path).exists() {
                return path.to_string();
            }
        }
        "/bin/sh".to_string()
    }
}

#[async_trait]
impl Terminal for LinuxTerminal {
    async fn spawn(&mut self, shell: Option<&str>, cols: u16, rows: u16) -> Result<()> {
        let shell_path = shell
            .map(String::from)
            .unwrap_or_else(Self::detect_shell);

        info!("spawning terminal: shell={}, cols={}, rows={}", shell_path, cols, rows);

        // Set initial window size
        let winsize = nix::pty::Winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };

        // Open PTY and fork
        let pty_result = unsafe {
            nix::pty::forkpty(Some(&winsize), None)
                .context("failed to forkpty")?
        };

        match pty_result.fork_result {
            nix::unistd::ForkResult::Child => {
                // Child process — exec the shell
                // Set TERM for proper terminal support
                std::env::set_var("TERM", "xterm-256color");

                let err = Command::new(&shell_path)
                    .arg("-l") // login shell
                    .exec(); // replaces process

                // If exec returns, it failed
                eprintln!("exec failed: {}", err);
                std::process::exit(1);
            }
            nix::unistd::ForkResult::Parent { child } => {
                // Parent — store master FD and child PID
                let master_raw = pty_result.master.as_raw_fd();

                // Set master FD to non-blocking for async I/O
                let flags = nix::fcntl::fcntl(master_raw, nix::fcntl::FcntlArg::F_GETFL)
                    .context("fcntl F_GETFL")?;
                let mut oflags = nix::fcntl::OFlag::from_bits_truncate(flags);
                oflags.insert(nix::fcntl::OFlag::O_NONBLOCK);
                nix::fcntl::fcntl(master_raw, nix::fcntl::FcntlArg::F_SETFL(oflags))
                    .context("fcntl F_SETFL")?;

                self.master_fd = Some(pty_result.master);
                self.child_pid = Some(child);

                // Create async FD for reading
                let async_fd = tokio::io::unix::AsyncFd::new(master_raw)
                    .context("failed to create AsyncFd")?;
                self.master_read = Some(async_fd);

                info!("terminal spawned: pid={}, shell={}", child, shell_path);
                Ok(())
            }
        }
    }

    async fn write_stdin(&mut self, data: &[u8]) -> Result<()> {
        let fd = self.master_fd.as_ref().context("terminal not spawned")?;
        let raw = fd.as_raw_fd();

        // Write using nix (synchronous but on non-blocking fd)
        match nix::unistd::write(raw, data) {
            Ok(_) => Ok(()),
            Err(nix::errno::Errno::EAGAIN) => {
                // Would block — try once more after a brief yield
                tokio::task::yield_now().await;
                nix::unistd::write(raw, data)
                    .map(|_| ())
                    .map_err(|e| anyhow::anyhow!("write to PTY failed: {}", e))
            }
            Err(e) => Err(anyhow::anyhow!("write to PTY failed: {}", e)),
        }
    }

    async fn read_stdout(&mut self) -> Result<Vec<u8>> {
        let async_fd = self.master_read.as_ref().context("terminal not spawned")?;

        let mut buf = vec![0u8; 4096];

        // Wait for the fd to be readable
        let mut guard = async_fd.readable().await
            .context("failed waiting for readable")?;

        match guard.try_io(|inner| {
            let raw = *inner.get_ref();
            match nix::unistd::read(raw, &mut buf) {
                Ok(0) => Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "EOF")),
                Ok(n) => {
                    buf.truncate(n);
                    Ok(buf.clone())
                }
                Err(nix::errno::Errno::EAGAIN) => {
                    Err(std::io::Error::new(std::io::ErrorKind::WouldBlock, "EAGAIN"))
                }
                Err(e) => Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("read error: {}", e),
                )),
            }
        }) {
            Ok(Ok(data)) => Ok(data),
            Ok(Err(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                Err(anyhow::anyhow!("terminal closed"))
            }
            Ok(Err(e)) => Err(e.into()),
            Err(_would_block) => {
                // False readiness — retry
                Ok(vec![])
            }
        }
    }

    async fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        let fd = self.master_fd.as_ref().context("terminal not spawned")?;
        let raw = fd.as_raw_fd();

        let winsize = nix::pty::Winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };

        // TIOCSWINSZ ioctl to set window size
        unsafe {
            let ret = libc::ioctl(raw, libc::TIOCSWINSZ, &winsize as *const _);
            if ret < 0 {
                return Err(anyhow::anyhow!(
                    "ioctl TIOCSWINSZ failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
        }

        // Send SIGWINCH to the child process group
        if let Some(pid) = self.child_pid {
            let _ = nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGWINCH);
        }

        debug!("terminal resized to {}x{}", cols, rows);
        Ok(())
    }

    fn is_alive(&self) -> bool {
        if let Some(pid) = self.child_pid {
            // Check if process is still running (signal 0 = check existence)
            match nix::sys::signal::kill(pid, None) {
                Ok(()) => true,
                Err(_) => false,
            }
        } else {
            false
        }
    }
}

impl Drop for LinuxTerminal {
    fn drop(&mut self) {
        // Kill the child process if still running
        if let Some(pid) = self.child_pid.take() {
            let _ = nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGTERM);
            // Wait briefly, then SIGKILL if needed
            std::thread::sleep(std::time::Duration::from_millis(100));
            let _ = nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGKILL);
            let _ = nix::sys::wait::waitpid(pid, Some(nix::sys::wait::WaitPidFlag::WNOHANG));
        }
    }
}
