//! X11 input injection using XTest extension.

use anyhow::{Context, Result, bail};
use agent_platform::input::{
    ButtonAction, InputInjector, KeyAction, Modifiers, MouseButton,
};

/// X11 input injector using XTest
pub struct X11InputInjector {
    conn: xcb::Connection,
    root: u32,
    initialized: bool,
}

// SAFETY: xcb::Connection is thread-safe when accessed serially
unsafe impl Send for X11InputInjector {}
unsafe impl Sync for X11InputInjector {}

// X11 event types for XTest
const MOTION_NOTIFY: u8 = 6;
const BUTTON_PRESS: u8 = 4;
const BUTTON_RELEASE: u8 = 5;
const KEY_PRESS: u8 = 2;
const KEY_RELEASE: u8 = 3;

// X11 button codes
const X11_BUTTON_LEFT: u8 = 1;
const X11_BUTTON_MIDDLE: u8 = 2;
const X11_BUTTON_RIGHT: u8 = 3;
const X11_BUTTON_SCROLL_UP: u8 = 4;
const X11_BUTTON_SCROLL_DOWN: u8 = 5;
const X11_BUTTON_SCROLL_LEFT: u8 = 6;
const X11_BUTTON_SCROLL_RIGHT: u8 = 7;

// Common X11 keycodes (evdev offset = keycode + 8)
const XK_SHIFT_L: u8 = 50;
const XK_CONTROL_L: u8 = 37;
const XK_ALT_L: u8 = 64;
const XK_SUPER_L: u8 = 133;

impl X11InputInjector {
    pub fn new() -> Self {
        Self {
            conn: unsafe { std::mem::zeroed() },
            root: 0,
            initialized: false,
        }
    }

    /// Initialize the input injector. Must be called before use.
    pub fn init(&mut self) -> Result<()> {
        let (conn, screen_num) = xcb::Connection::connect(None)
            .context("failed to connect to X11 display")?;

        let setup = conn.get_setup();
        let screen = setup
            .roots()
            .nth(screen_num as usize)
            .context("no X11 screen found")?;

        self.root = screen.root();
        self.conn = conn;

        // Verify XTest extension
        let query = xcb::xtest::get_version(&self.conn, 2, 1);
        query.get_reply().context("XTest extension not available")?;

        self.initialized = true;
        tracing::info!("X11 input injector initialized (XTest)");

        Ok(())
    }

    fn fake_input(&self, event_type: u8, detail: u8, x: i16, y: i16) -> Result<()> {
        if !self.initialized {
            bail!("input injector not initialized");
        }

        let cookie = xcb::xtest::fake_input_checked(
            &self.conn,
            event_type,
            detail,
            0,  // time = CurrentTime
            self.root,
            x,
            y,
            0, // device_id
        );
        cookie.request_check()
            .context("XTest fake_input failed")?;

        self.conn.flush();
        Ok(())
    }

    fn press_modifier(&self, keycode: u8, press: bool) -> Result<()> {
        let event_type = if press { KEY_PRESS } else { KEY_RELEASE };
        self.fake_input(event_type, keycode, 0, 0)
    }

    fn apply_modifiers(&self, mods: Modifiers, press: bool) -> Result<()> {
        if mods.shift {
            self.press_modifier(XK_SHIFT_L, press)?;
        }
        if mods.ctrl {
            self.press_modifier(XK_CONTROL_L, press)?;
        }
        if mods.alt {
            self.press_modifier(XK_ALT_L, press)?;
        }
        if mods.meta {
            self.press_modifier(XK_SUPER_L, press)?;
        }
        Ok(())
    }
}

impl InputInjector for X11InputInjector {
    fn mouse_move(&mut self, x: u32, y: u32) -> Result<()> {
        // MotionNotify with absolute coordinates
        // XTest fake_input with rootX/rootY and detail=0 means absolute move
        self.fake_input(MOTION_NOTIFY, 0, x as i16, y as i16)
    }

    fn mouse_button(&mut self, btn: MouseButton, action: ButtonAction) -> Result<()> {
        let x11_btn = match btn {
            MouseButton::Left => X11_BUTTON_LEFT,
            MouseButton::Middle => X11_BUTTON_MIDDLE,
            MouseButton::Right => X11_BUTTON_RIGHT,
        };
        let event_type = match action {
            ButtonAction::Press => BUTTON_PRESS,
            ButtonAction::Release => BUTTON_RELEASE,
        };
        self.fake_input(event_type, x11_btn, 0, 0)
    }

    fn mouse_scroll(&mut self, dx: i32, dy: i32) -> Result<()> {
        // X11 scroll is done via button 4/5 (vertical) and 6/7 (horizontal)
        // Each click is one "notch"
        if dy != 0 {
            let btn = if dy < 0 { X11_BUTTON_SCROLL_UP } else { X11_BUTTON_SCROLL_DOWN };
            let clicks = dy.unsigned_abs();
            for _ in 0..clicks {
                self.fake_input(BUTTON_PRESS, btn, 0, 0)?;
                self.fake_input(BUTTON_RELEASE, btn, 0, 0)?;
            }
        }
        if dx != 0 {
            let btn = if dx < 0 { X11_BUTTON_SCROLL_LEFT } else { X11_BUTTON_SCROLL_RIGHT };
            let clicks = dx.unsigned_abs();
            for _ in 0..clicks {
                self.fake_input(BUTTON_PRESS, btn, 0, 0)?;
                self.fake_input(BUTTON_RELEASE, btn, 0, 0)?;
            }
        }
        Ok(())
    }

    fn key_press(&mut self, scancode: u16, action: KeyAction, mods: Modifiers) -> Result<()> {
        // Scancode is assumed to be a Linux evdev scancode.
        // X11 keycode = evdev scancode + 8
        let x11_keycode = (scancode as u32 + 8) as u8;

        match action {
            KeyAction::Press => {
                self.apply_modifiers(mods, true)?;
                self.fake_input(KEY_PRESS, x11_keycode, 0, 0)?;
            }
            KeyAction::Release => {
                self.fake_input(KEY_RELEASE, x11_keycode, 0, 0)?;
                self.apply_modifiers(mods, false)?;
            }
        }
        Ok(())
    }

    fn type_text(&mut self, text: &str) -> Result<()> {
        // For text typing, use XTest to simulate key events.
        // This is a simplified version — for full Unicode support,
        // XInput2 or xdotool approach would be better.
        // Here we handle ASCII by mapping to keycodes.
        for ch in text.chars() {
            if let Some((keycode, shift)) = char_to_keycode(ch) {
                if shift {
                    self.press_modifier(XK_SHIFT_L, true)?;
                }
                self.fake_input(KEY_PRESS, keycode, 0, 0)?;
                self.fake_input(KEY_RELEASE, keycode, 0, 0)?;
                if shift {
                    self.press_modifier(XK_SHIFT_L, false)?;
                }
            }
        }
        Ok(())
    }
}

/// Map ASCII character to X11 keycode + shift flag.
/// Keycodes here are for a standard US keyboard layout (evdev + 8).
fn char_to_keycode(ch: char) -> Option<(u8, bool)> {
    // X11 keycode = evdev + 8. These are standard US QWERTY keycodes.
    match ch {
        'a'..='z' => Some((ch as u8 - b'a' + 38, false)),  // 'a' = keycode 38
        'A'..='Z' => Some((ch as u8 - b'A' + 38, true)),
        '0' => Some((19, false)),
        '1'..='9' => Some((ch as u8 - b'1' + 10, false)),
        ' ' => Some((65, false)),
        '\n' | '\r' => Some((36, false)),     // Return
        '\t' => Some((23, false)),             // Tab
        '-' => Some((20, false)),
        '=' => Some((21, false)),
        '[' => Some((34, false)),
        ']' => Some((35, false)),
        '\\' => Some((51, false)),
        ';' => Some((47, false)),
        '\'' => Some((48, false)),
        ',' => Some((59, false)),
        '.' => Some((60, false)),
        '/' => Some((61, false)),
        '`' => Some((49, false)),
        // Shifted variants
        '!' => Some((10, true)),
        '@' => Some((11, true)),
        '#' => Some((12, true)),
        '$' => Some((13, true)),
        '%' => Some((14, true)),
        '^' => Some((15, true)),
        '&' => Some((16, true)),
        '*' => Some((17, true)),
        '(' => Some((18, true)),
        ')' => Some((19, true)),
        '_' => Some((20, true)),
        '+' => Some((21, true)),
        '{' => Some((34, true)),
        '}' => Some((35, true)),
        '|' => Some((51, true)),
        ':' => Some((47, true)),
        '"' => Some((48, true)),
        '<' => Some((59, true)),
        '>' => Some((60, true)),
        '?' => Some((61, true)),
        '~' => Some((49, true)),
        _ => None,
    }
}
