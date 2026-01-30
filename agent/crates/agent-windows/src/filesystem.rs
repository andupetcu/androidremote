use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use agent_platform::filesystem::{FileEntry, FileSystem};
use anyhow::{Context, Result};

pub struct WindowsFileSystem;

impl WindowsFileSystem {
    pub fn new() -> Self {
        Self
    }

    fn get_permissions(path: &Path) -> Option<String> {
        let meta = fs::metadata(path).ok()?;
        let mut perms = String::new();

        if meta.is_dir() {
            perms.push('d');
        } else {
            perms.push('-');
        }

        if meta.permissions().readonly() {
            perms.push_str("r-");
        } else {
            perms.push_str("rw");
        }

        Some(perms)
    }
}

impl FileSystem for WindowsFileSystem {
    fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>> {
        let dir_path = Path::new(path);
        let entries = fs::read_dir(dir_path)
            .with_context(|| format!("failed to read directory: {}", path))?;

        let mut result: Vec<FileEntry> = Vec::new();

        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };

            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };

            let name = entry.file_name().to_string_lossy().to_string();
            let entry_path = entry.path().to_string_lossy().to_string();

            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64);

            let permissions = Self::get_permissions(&entry.path());

            result.push(FileEntry {
                name,
                path: entry_path,
                is_dir: meta.is_dir(),
                size: if meta.is_dir() { 0 } else { meta.len() },
                modified,
                permissions,
            });
        }

        // Sort: directories first, then alphabetical
        result.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        Ok(result)
    }

    fn read_file(&self, path: &str) -> Result<Vec<u8>> {
        fs::read(path).with_context(|| format!("failed to read file: {}", path))
    }

    fn write_file(&self, path: &str, data: &[u8]) -> Result<()> {
        // Create parent directories if needed
        if let Some(parent) = Path::new(path).parent() {
            if !parent.exists() {
                fs::create_dir_all(parent)
                    .with_context(|| format!("failed to create parent dirs: {}", parent.display()))?;
            }
        }
        fs::write(path, data).with_context(|| format!("failed to write file: {}", path))
    }

    fn delete(&self, path: &str) -> Result<()> {
        let p = Path::new(path);
        if p.is_dir() {
            fs::remove_dir_all(p).with_context(|| format!("failed to delete directory: {}", path))
        } else {
            fs::remove_file(p).with_context(|| format!("failed to delete file: {}", path))
        }
    }

    fn exists(&self, path: &str) -> bool {
        Path::new(path).exists()
    }

    fn metadata(&self, path: &str) -> Result<FileEntry> {
        let p = Path::new(path);
        let meta = fs::metadata(p).with_context(|| format!("failed to get metadata: {}", path))?;

        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string());

        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);

        Ok(FileEntry {
            name,
            path: path.to_string(),
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            modified,
            permissions: Self::get_permissions(p),
        })
    }
}
