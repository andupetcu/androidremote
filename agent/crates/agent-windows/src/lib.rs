// Windows platform implementations

#[cfg(target_os = "windows")]
pub mod screen;

#[cfg(target_os = "windows")]
pub mod input;

#[cfg(target_os = "windows")]
pub mod terminal;

#[cfg(target_os = "windows")]
pub mod filesystem;

#[cfg(target_os = "windows")]
pub mod system_info;

#[cfg(target_os = "windows")]
pub mod service;

#[cfg(target_os = "windows")]
pub mod session_detect;

#[cfg(target_os = "windows")]
pub mod ipc;

#[cfg(target_os = "windows")]
pub mod helper_launcher;
