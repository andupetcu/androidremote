//! Windows input injection using SendInput API.

use anyhow::{Result, Context};
use agent_platform::input::{
    ButtonAction, InputInjector, KeyAction, Modifiers, MouseButton,
};
use tracing::debug;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, MOUSEINPUT,
    KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, KEYEVENTF_UNICODE,
    MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE,
    MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL,
    MOUSEEVENTF_HWHEEL,
};
use windows::Win32::UI::WindowsAndMessaging::GetSystemMetrics;
use windows::Win32::UI::WindowsAndMessaging::{SM_CXSCREEN, SM_CYSCREEN};

/// Windows input injector using SendInput API
pub struct WindowsInputInjector {
    screen_width: i32,
    screen_height: i32,
}

// SAFETY: SendInput is thread-safe when accessed serially
unsafe impl Send for WindowsInputInjector {}
unsafe impl Sync for WindowsInputInjector {}

impl WindowsInputInjector {
    pub fn new() -> Self {
        let screen_width = unsafe { GetSystemMetrics(SM_CXSCREEN) };
        let screen_height = unsafe { GetSystemMetrics(SM_CYSCREEN) };
        Self {
            screen_width: screen_width.max(1),
            screen_height: screen_height.max(1),
        }
    }

    fn send_inputs(&self, inputs: &[INPUT]) -> Result<()> {
        let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent as usize != inputs.len() {
            anyhow::bail!(
                "SendInput: sent {} of {} inputs",
                sent,
                inputs.len()
            );
        }
        Ok(())
    }

    /// Convert absolute pixel coordinates to normalized 0-65535 range
    fn normalize_coords(&self, x: u32, y: u32) -> (i32, i32) {
        let nx = ((x as i64 * 65535) / self.screen_width as i64) as i32;
        let ny = ((y as i64 * 65535) / self.screen_height as i64) as i32;
        (nx, ny)
    }
}

impl InputInjector for WindowsInputInjector {
    fn mouse_move(&mut self, x: u32, y: u32) -> Result<()> {
        let (nx, ny) = self.normalize_coords(x, y);
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: nx,
                    dy: ny,
                    mouseData: 0,
                    dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        self.send_inputs(&[input])
    }

    fn mouse_button(&mut self, btn: MouseButton, action: ButtonAction) -> Result<()> {
        let flags = match (btn, action) {
            (MouseButton::Left, ButtonAction::Press) => MOUSEEVENTF_LEFTDOWN,
            (MouseButton::Left, ButtonAction::Release) => MOUSEEVENTF_LEFTUP,
            (MouseButton::Right, ButtonAction::Press) => MOUSEEVENTF_RIGHTDOWN,
            (MouseButton::Right, ButtonAction::Release) => MOUSEEVENTF_RIGHTUP,
            (MouseButton::Middle, ButtonAction::Press) => MOUSEEVENTF_MIDDLEDOWN,
            (MouseButton::Middle, ButtonAction::Release) => MOUSEEVENTF_MIDDLEUP,
        };

        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        self.send_inputs(&[input])
    }

    fn mouse_scroll(&mut self, dx: i32, dy: i32) -> Result<()> {
        let mut inputs = Vec::new();

        // Vertical scroll
        if dy != 0 {
            inputs.push(INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx: 0,
                        dy: 0,
                        mouseData: (dy * 120) as u32, // WHEEL_DELTA = 120
                        dwFlags: MOUSEEVENTF_WHEEL,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
        }

        // Horizontal scroll
        if dx != 0 {
            inputs.push(INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx: 0,
                        dy: 0,
                        mouseData: (dx * 120) as u32,
                        dwFlags: MOUSEEVENTF_HWHEEL,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
        }

        if !inputs.is_empty() {
            self.send_inputs(&inputs)?;
        }
        Ok(())
    }

    fn key_press(&mut self, scancode: u16, action: KeyAction, mods: Modifiers) -> Result<()> {
        let mut inputs = Vec::new();

        let key_flags = match action {
            KeyAction::Press => KEYEVENTF_SCANCODE,
            KeyAction::Release => KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP,
        };

        // Press modifier keys first (on press), release after (on release)
        if action == KeyAction::Press {
            if mods.shift {
                inputs.push(make_key_input(0x2A, KEYEVENTF_SCANCODE)); // Left Shift
            }
            if mods.ctrl {
                inputs.push(make_key_input(0x1D, KEYEVENTF_SCANCODE)); // Left Ctrl
            }
            if mods.alt {
                inputs.push(make_key_input(0x38, KEYEVENTF_SCANCODE)); // Left Alt
            }
            if mods.meta {
                inputs.push(make_key_input(0x5B, KEYEVENTF_SCANCODE)); // Left Win (scancode 0x5B)
            }
        }

        // The actual key
        inputs.push(make_key_input(scancode, key_flags));

        // Release modifiers (on key release)
        if action == KeyAction::Release {
            if mods.meta {
                inputs.push(make_key_input(0x5B, KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP));
            }
            if mods.alt {
                inputs.push(make_key_input(0x38, KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP));
            }
            if mods.ctrl {
                inputs.push(make_key_input(0x1D, KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP));
            }
            if mods.shift {
                inputs.push(make_key_input(0x2A, KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP));
            }
        }

        self.send_inputs(&inputs)
    }

    fn type_text(&mut self, text: &str) -> Result<()> {
        let mut inputs = Vec::new();

        for ch in text.encode_utf16() {
            // Key down
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(0),
                        wScan: ch,
                        dwFlags: KEYEVENTF_UNICODE,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
            // Key up
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(0),
                        wScan: ch,
                        dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
        }

        if !inputs.is_empty() {
            self.send_inputs(&inputs)?;
        }
        Ok(())
    }
}

fn make_key_input(
    scancode: u16,
    flags: windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS,
) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(0),
                wScan: scancode,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// Factory function for creating input injector on Windows
pub fn create_input_injector() -> Result<Box<dyn InputInjector>> {
    tracing::info!("using SendInput for Windows input injection");
    Ok(Box::new(WindowsInputInjector::new()))
}
