use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ButtonAction {
    Press,
    Release,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum KeyAction {
    Press,
    Release,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct Modifiers {
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub meta: bool,
}

pub trait InputInjector: Send + Sync {
    fn mouse_move(&mut self, x: u32, y: u32) -> Result<()>;
    fn mouse_button(&mut self, btn: MouseButton, action: ButtonAction) -> Result<()>;
    fn mouse_scroll(&mut self, dx: i32, dy: i32) -> Result<()>;
    fn key_press(&mut self, scancode: u16, action: KeyAction, mods: Modifiers) -> Result<()>;
    fn type_text(&mut self, text: &str) -> Result<()>;
}
