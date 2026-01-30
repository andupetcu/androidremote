// Linux platform implementations

#[cfg(target_os = "linux")]
pub mod terminal;

#[cfg(target_os = "linux")]
pub mod screen_x11;
#[cfg(target_os = "linux")]
pub mod screen;

#[cfg(target_os = "linux")]
pub mod input_x11;
#[cfg(target_os = "linux")]
pub mod input;

#[cfg(target_os = "linux")]
pub mod filesystem;

#[cfg(target_os = "linux")]
pub mod system_info;

#[cfg(target_os = "linux")]
pub mod screen_wayland;

// pub mod input_wayland;  // Wayland input via uinput (future)

#[cfg(target_os = "linux")]
pub mod service;
