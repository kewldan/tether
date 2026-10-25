//! Control messages (client → device) of scrcpy v5.0.1, encoded exactly as
//! `app/src/control_msg.c` does and `ControlMessageReader.java` reads them.
//! The test vectors are the ones of `app/tests/test_control_msg_serialize.c`.

use serde::Deserialize;

/// `INJECT_TEXT` is truncated by the client to this many bytes.
pub const INJECT_TEXT_MAX: usize = 300;
/// The whole message is limited to 256 KiB; clipboard header is 14 bytes.
pub const CLIPBOARD_TEXT_MAX: usize = (1 << 18) - 14;

/// Pointer id of a mouse; with only the primary button it is injected as a
/// finger anyway, other buttons make it a real mouse event.
pub const POINTER_MOUSE: i64 = -1;
/// Pointer id for "a finger" when the host has no real touch ids.
pub const POINTER_FINGER: i64 = -2;

mod kind {
    pub const INJECT_KEYCODE: u8 = 0;
    pub const INJECT_TEXT: u8 = 1;
    pub const INJECT_TOUCH: u8 = 2;
    pub const INJECT_SCROLL: u8 = 3;
    pub const BACK_OR_SCREEN_ON: u8 = 4;
    pub const EXPAND_NOTIFICATION_PANEL: u8 = 5;
    pub const EXPAND_SETTINGS_PANEL: u8 = 6;
    pub const COLLAPSE_PANELS: u8 = 7;
    pub const GET_CLIPBOARD: u8 = 8;
    pub const SET_CLIPBOARD: u8 = 9;
    pub const SET_DISPLAY_POWER: u8 = 10;
    pub const ROTATE_DEVICE: u8 = 11;
    pub const RESET_VIDEO: u8 = 17;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyAction {
    Down,
    Up,
}

impl KeyAction {
    fn code(self) -> u8 {
        match self {
            Self::Down => 0,
            Self::Up => 1,
        }
    }
}

/// `MotionEvent.ACTION_*` used for touches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TouchAction {
    Down,
    Up,
    Move,
    Cancel,
}

impl TouchAction {
    fn code(self) -> u8 {
        match self {
            Self::Down => 0,
            Self::Up => 1,
            Self::Move => 2,
            Self::Cancel => 3,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CopyKey {
    None,
    Copy,
    Cut,
}

/// A point in video-frame coordinates plus the frame size it refers to.
/// The server drops events whose size differs from the current capture
/// size (e.g. right after a rotation), so the size must come from the last
/// session packet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub x: i32,
    pub y: i32,
    pub width: u16,
    pub height: u16,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ControlMessage {
    /// `KeyEvent` with an Android keycode and meta state.
    Key {
        action: KeyAction,
        keycode: u32,
        #[serde(default)]
        repeat: u32,
        #[serde(default)]
        metastate: u32,
    },
    /// Text typed as-is (the device maps characters to key events).
    Text {
        text: String,
    },
    Touch {
        action: TouchAction,
        #[serde(default = "finger")]
        pointer_id: i64,
        #[serde(flatten)]
        position: Position,
        #[serde(default = "full_pressure")]
        pressure: f32,
        /// `MotionEvent.BUTTON_*` pressed or released by this event;
        /// only meaningful for the mouse pointer.
        #[serde(default)]
        action_button: u32,
        /// `MotionEvent.BUTTON_*` bits held after this event.
        #[serde(default)]
        buttons: u32,
    },
    /// Wheel scroll; values are clamped to ±16 notches.
    Scroll {
        #[serde(flatten)]
        position: Position,
        hscroll: f32,
        vscroll: f32,
    },
    /// BACK, or turns the screen on if it is off.
    BackOrScreenOn {
        action: KeyAction,
    },
    ExpandNotificationPanel,
    ExpandSettingsPanel,
    CollapsePanels,
    /// Asks for the device clipboard (optionally pressing COPY/CUT first);
    /// the answer comes back as a clipboard device message.
    GetClipboard {
        #[serde(default = "no_copy_key")]
        copy_key: CopyKey,
    },
    /// Sets the device clipboard, optionally pasting it. A non-zero
    /// `sequence` is acknowledged by the device.
    SetClipboard {
        #[serde(default)]
        sequence: u64,
        text: String,
        #[serde(default)]
        paste: bool,
    },
    /// Turns the physical display on/off while mirroring keeps going.
    SetDisplayPower {
        on: bool,
    },
    RotateDevice,
    /// Asks the encoder for a fresh key frame (e.g. after a decoder error).
    ResetVideo,
}

fn finger() -> i64 {
    POINTER_FINGER
}

fn full_pressure() -> f32 {
    1.0
}

fn no_copy_key() -> CopyKey {
    CopyKey::None
}

impl ControlMessage {
    pub fn encode(&self) -> Vec<u8> {
        let mut b = Vec::with_capacity(32);
        match self {
            Self::Key {
                action,
                keycode,
                repeat,
                metastate,
            } => {
                b.push(kind::INJECT_KEYCODE);
                b.push(action.code());
                b.extend_from_slice(&keycode.to_be_bytes());
                b.extend_from_slice(&repeat.to_be_bytes());
                b.extend_from_slice(&metastate.to_be_bytes());
            }
            Self::Text { text } => {
                b.push(kind::INJECT_TEXT);
                write_string(&mut b, text, INJECT_TEXT_MAX);
            }
            Self::Touch {
                action,
                pointer_id,
                position,
                pressure,
                action_button,
                buttons,
            } => {
                b.push(kind::INJECT_TOUCH);
                b.push(action.code());
                b.extend_from_slice(&pointer_id.to_be_bytes());
                write_position(&mut b, position);
                b.extend_from_slice(&u16_fixed_point(*pressure).to_be_bytes());
                b.extend_from_slice(&action_button.to_be_bytes());
                b.extend_from_slice(&buttons.to_be_bytes());
            }
            Self::Scroll {
                position,
                hscroll,
                vscroll,
            } => {
                b.push(kind::INJECT_SCROLL);
                write_position(&mut b, position);
                b.extend_from_slice(&i16_fixed_point(hscroll / 16.0).to_be_bytes());
                b.extend_from_slice(&i16_fixed_point(vscroll / 16.0).to_be_bytes());
                b.extend_from_slice(&0u32.to_be_bytes());
            }
            Self::BackOrScreenOn { action } => {
                b.push(kind::BACK_OR_SCREEN_ON);
                b.push(action.code());
            }
            Self::ExpandNotificationPanel => b.push(kind::EXPAND_NOTIFICATION_PANEL),
            Self::ExpandSettingsPanel => b.push(kind::EXPAND_SETTINGS_PANEL),
            Self::CollapsePanels => b.push(kind::COLLAPSE_PANELS),
            Self::GetClipboard { copy_key } => {
                b.push(kind::GET_CLIPBOARD);
                b.push(match copy_key {
                    CopyKey::None => 0,
                    CopyKey::Copy => 1,
                    CopyKey::Cut => 2,
                });
            }
            Self::SetClipboard {
                sequence,
                text,
                paste,
            } => {
                b.push(kind::SET_CLIPBOARD);
                b.extend_from_slice(&sequence.to_be_bytes());
                b.push(u8::from(*paste));
                write_string(&mut b, text, CLIPBOARD_TEXT_MAX);
            }
            Self::SetDisplayPower { on } => {
                b.push(kind::SET_DISPLAY_POWER);
                b.push(u8::from(*on));
            }
            Self::RotateDevice => b.push(kind::ROTATE_DEVICE),
            Self::ResetVideo => b.push(kind::RESET_VIDEO),
        }
        b
    }
}

fn write_position(b: &mut Vec<u8>, p: &Position) {
    b.extend_from_slice(&p.x.to_be_bytes());
    b.extend_from_slice(&p.y.to_be_bytes());
    b.extend_from_slice(&p.width.to_be_bytes());
    b.extend_from_slice(&p.height.to_be_bytes());
}

/// u32 length + UTF-8 bytes, truncated on a character boundary.
fn write_string(b: &mut Vec<u8>, text: &str, max: usize) {
    let mut len = text.len().min(max);
    while !text.is_char_boundary(len) {
        len -= 1;
    }
    b.extend_from_slice(&(len as u32).to_be_bytes());
    b.extend_from_slice(&text.as_bytes()[..len]);
}

/// `sc_float_to_u16fp`: [0, 1] → 0..=0xFFFF.
fn u16_fixed_point(f: f32) -> u16 {
    let f = if f.is_nan() { 0.0 } else { f.clamp(0.0, 1.0) };
    ((f * 65536.0) as u32).min(0xFFFF) as u16
}

/// `sc_float_to_i16fp`: [-1, 1] → -0x8000..=0x7FFF.
fn i16_fixed_point(f: f32) -> i16 {
    let f = if f.is_nan() { 0.0 } else { f.clamp(-1.0, 1.0) };
    ((f * 32768.0) as i32).clamp(-0x8000, 0x7FFF) as i16
}

#[cfg(test)]
mod tests {
    use super::*;

    fn from_json(json: &str) -> ControlMessage {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn inject_keycode() {
        let msg = ControlMessage::Key {
            action: KeyAction::Up,
            keycode: 66, // ENTER
            repeat: 5,
            metastate: 0x41, // SHIFT_ON | SHIFT_LEFT_ON
        };
        assert_eq!(
            msg.encode(),
            [0, 1, 0, 0, 0, 0x42, 0, 0, 0, 5, 0, 0, 0, 0x41]
        );
        assert_eq!(
            from_json(r#"{"type":"key","action":"up","keycode":66,"repeat":5,"metastate":65}"#),
            msg
        );
    }

    #[test]
    fn inject_text() {
        let msg = ControlMessage::Text {
            text: "hello, world!".into(),
        };
        let mut expected = vec![1, 0, 0, 0, 13];
        expected.extend_from_slice(b"hello, world!");
        assert_eq!(msg.encode(), expected);
    }

    #[test]
    fn inject_text_is_truncated_on_char_boundary() {
        let long = "a".repeat(INJECT_TEXT_MAX + 10);
        let out = ControlMessage::Text { text: long }.encode();
        assert_eq!(out.len(), 5 + INJECT_TEXT_MAX);
        assert_eq!(&out[1..5], &[0, 0, 0x01, 0x2C]);

        // 299 ASCII bytes + a 2-byte letter would cross the limit.
        let text = format!("{}é", "a".repeat(INJECT_TEXT_MAX - 1));
        let out = ControlMessage::Text { text }.encode();
        assert_eq!(out.len(), 5 + INJECT_TEXT_MAX - 1);
    }

    #[test]
    fn inject_touch_event() {
        let msg = ControlMessage::Touch {
            action: TouchAction::Down,
            pointer_id: 0x1234_5678_8765_4321,
            position: Position {
                x: 100,
                y: 200,
                width: 1080,
                height: 1920,
            },
            pressure: 1.0,
            action_button: 1,
            buttons: 1,
        };
        assert_eq!(
            msg.encode(),
            [
                2, 0, // type, ACTION_DOWN
                0x12, 0x34, 0x56, 0x78, 0x87, 0x65, 0x43, 0x21, // pointer id
                0, 0, 0, 0x64, 0, 0, 0, 0xC8, // 100 200
                0x04, 0x38, 0x07, 0x80, // 1080 1920
                0xFF, 0xFF, // pressure
                0, 0, 0, 1, // BUTTON_PRIMARY (action button)
                0, 0, 0, 1, // BUTTON_PRIMARY (buttons)
            ]
        );
    }

    #[test]
    fn touch_from_json_defaults_to_finger() {
        let msg =
            from_json(r#"{"type":"touch","action":"move","x":5,"y":6,"width":1280,"height":2856}"#);
        let out = msg.encode();
        assert_eq!(out[1], 2); // ACTION_MOVE
        assert_eq!(&out[2..10], &(-2i64).to_be_bytes()); // generic finger
        assert_eq!(&out[22..24], &[0xFF, 0xFF]);
        assert_eq!(&out[24..], &[0; 8]);
    }

    #[test]
    fn inject_scroll_event() {
        let msg = ControlMessage::Scroll {
            position: Position {
                x: 260,
                y: 1026,
                width: 1080,
                height: 1920,
            },
            hscroll: 16.0,
            vscroll: -16.0,
        };
        assert_eq!(
            msg.encode(),
            [
                3, 0, 0, 0x01, 0x04, 0, 0, 0x04, 0x02, // 260 1026
                0x04, 0x38, 0x07, 0x80, // 1080 1920
                0x7F, 0xFF, // 16
                0x80, 0x00, // -16
                0, 0, 0, 0, // buttons
            ]
        );
        // Out-of-range values are clamped instead of overflowing.
        let msg = from_json(
            r#"{"type":"scroll","x":0,"y":0,"width":1,"height":1,"hscroll":-99,"vscroll":0.5}"#,
        );
        let out = msg.encode();
        assert_eq!(&out[13..17], &[0x80, 0x00, 0x04, 0x00]);
    }

    #[test]
    fn simple_messages() {
        assert_eq!(
            ControlMessage::BackOrScreenOn {
                action: KeyAction::Up
            }
            .encode(),
            [4, 1]
        );
        assert_eq!(ControlMessage::ExpandNotificationPanel.encode(), [5]);
        assert_eq!(ControlMessage::ExpandSettingsPanel.encode(), [6]);
        assert_eq!(ControlMessage::CollapsePanels.encode(), [7]);
        assert_eq!(
            from_json(r#"{"type":"getClipboard","copyKey":"copy"}"#).encode(),
            [8, 1]
        );
        assert_eq!(from_json(r#"{"type":"getClipboard"}"#).encode(), [8, 0]);
        assert_eq!(
            from_json(r#"{"type":"setDisplayPower","on":true}"#).encode(),
            [10, 1]
        );
        assert_eq!(from_json(r#"{"type":"rotateDevice"}"#).encode(), [11]);
        assert_eq!(from_json(r#"{"type":"resetVideo"}"#).encode(), [17]);
    }

    #[test]
    fn set_clipboard() {
        let msg = ControlMessage::SetClipboard {
            sequence: 0x0102_0304_0506_0708,
            text: "hello, world!".into(),
            paste: true,
        };
        let mut expected = vec![9, 1, 2, 3, 4, 5, 6, 7, 8, 1, 0, 0, 0, 13];
        expected.extend_from_slice(b"hello, world!");
        assert_eq!(msg.encode(), expected);
    }

    #[test]
    fn fixed_point_edges() {
        assert_eq!(u16_fixed_point(0.0), 0);
        assert_eq!(u16_fixed_point(0.5), 0x8000);
        assert_eq!(u16_fixed_point(1.0), 0xFFFF);
        assert_eq!(u16_fixed_point(f32::NAN), 0);
        assert_eq!(i16_fixed_point(1.0), 0x7FFF);
        assert_eq!(i16_fixed_point(-1.0), -0x8000);
        assert_eq!(i16_fixed_point(0.0), 0);
    }
}
