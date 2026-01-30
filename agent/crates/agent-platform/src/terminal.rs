use anyhow::Result;
use async_trait::async_trait;

#[async_trait]
pub trait Terminal: Send {
    /// Spawn a new terminal session with the given shell and dimensions
    async fn spawn(&mut self, shell: Option<&str>, cols: u16, rows: u16) -> Result<()>;

    /// Write data to the terminal's stdin
    async fn write_stdin(&mut self, data: &[u8]) -> Result<()>;

    /// Read available data from the terminal's stdout
    async fn read_stdout(&mut self) -> Result<Vec<u8>>;

    /// Resize the terminal
    async fn resize(&mut self, cols: u16, rows: u16) -> Result<()>;

    /// Check if the terminal process is still alive
    fn is_alive(&self) -> bool;
}
