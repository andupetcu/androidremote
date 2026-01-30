use anyhow::Result;

pub trait ServiceManager: Send + Sync {
    /// Install the agent as a system service
    fn install(&self) -> Result<()>;

    /// Uninstall the agent system service
    fn uninstall(&self) -> Result<()>;

    /// Start the service
    fn start(&self) -> Result<()>;

    /// Stop the service
    fn stop(&self) -> Result<()>;

    /// Check if the service is currently running
    fn is_running(&self) -> Result<bool>;
}
