use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<u64>,
    pub permissions: Option<String>,
}

pub trait FileSystem: Send + Sync {
    fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>>;
    fn read_file(&self, path: &str) -> Result<Vec<u8>>;
    fn write_file(&self, path: &str, data: &[u8]) -> Result<()>;
    fn delete(&self, path: &str) -> Result<()>;
    fn exists(&self, path: &str) -> bool;
    fn metadata(&self, path: &str) -> Result<FileEntry>;
}
