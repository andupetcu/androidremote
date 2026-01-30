use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::UNIX_EPOCH;

use anyhow::{Context, Result};
use agent_platform::filesystem::{FileEntry, FileSystem};

pub struct LinuxFileSystem;

impl LinuxFileSystem {
    pub fn new() -> Self {
        Self
    }

    fn to_file_entry(path: &Path) -> Result<FileEntry> {
        let meta = fs::metadata(path)
            .with_context(|| format!("failed to stat {}", path.display()))?;

        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs());

        let permissions = Some(format!("{:o}", meta.permissions().mode() & 0o7777));

        Ok(FileEntry {
            name: path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.to_string_lossy().to_string()),
            path: path.to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
            size: meta.len(),
            modified,
            permissions,
        })
    }
}

impl FileSystem for LinuxFileSystem {
    fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>> {
        let dir = Path::new(path);
        let entries = fs::read_dir(dir)
            .with_context(|| format!("failed to read directory {}", path))?;

        let mut result = Vec::new();
        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    tracing::warn!("skipping dir entry: {}", e);
                    continue;
                }
            };

            match Self::to_file_entry(&entry.path()) {
                Ok(fe) => result.push(fe),
                Err(e) => {
                    tracing::warn!("skipping {}: {}", entry.path().display(), e);
                }
            }
        }

        // Sort: directories first, then alphabetically
        result.sort_by(|a, b| {
            b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        Ok(result)
    }

    fn read_file(&self, path: &str) -> Result<Vec<u8>> {
        fs::read(path).with_context(|| format!("failed to read file {}", path))
    }

    fn write_file(&self, path: &str, data: &[u8]) -> Result<()> {
        // Create parent directories if they don't exist
        if let Some(parent) = Path::new(path).parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create parent dirs for {}", path))?;
        }
        fs::write(path, data).with_context(|| format!("failed to write file {}", path))
    }

    fn delete(&self, path: &str) -> Result<()> {
        let p = Path::new(path);
        if p.is_dir() {
            fs::remove_dir_all(p)
                .with_context(|| format!("failed to delete directory {}", path))
        } else {
            fs::remove_file(p)
                .with_context(|| format!("failed to delete file {}", path))
        }
    }

    fn exists(&self, path: &str) -> bool {
        Path::new(path).exists()
    }

    fn metadata(&self, path: &str) -> Result<FileEntry> {
        Self::to_file_entry(Path::new(path))
    }
}
