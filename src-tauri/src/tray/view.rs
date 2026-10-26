//! What the tray shows, as plain data: rendered from the device list and
//! the webview's settings, compared before touching the native menu.

use std::collections::HashMap;

use serde::Deserialize;

use crate::adb::devices::{Device, DeviceState};

/// Windows truncates longer tray tooltips.
const TOOLTIP_MAX: usize = 127;

/// Localized menu texts, pushed by the webview. English until then.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TrayLabels {
    pub open: String,
    pub quit: String,
    /// "Take screenshot" while no device is ready.
    pub screenshot: String,
    /// "Screenshot of {name}".
    pub screenshot_of: String,
    pub no_devices: String,
    /// Device state labels keyed like the frontend `DeviceState.kind`.
    pub states: HashMap<String, String>,
}

impl Default for TrayLabels {
    fn default() -> Self {
        Self {
            open: "Open Tether".into(),
            quit: "Quit Tether".into(),
            screenshot: "Take screenshot".into(),
            screenshot_of: "Screenshot of {name}".into(),
            no_devices: "No devices connected".into(),
            states: HashMap::new(),
        }
    }
}

/// Everything the webview knows that the tray needs.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TrayConfig {
    /// Show the icon at all.
    pub visible: bool,
    /// Closing the main window hides it instead of quitting.
    pub close_to_tray: bool,
    /// The device the workspace shows; target of "Screenshot".
    pub selected: Option<String>,
    /// Display names (alias, AVD name, model) keyed by serial.
    pub names: HashMap<String, String>,
    pub labels: TrayLabels,
}

impl Default for TrayConfig {
    fn default() -> Self {
        Self {
            visible: true,
            close_to_tray: false,
            selected: None,
            names: HashMap::new(),
            labels: TrayLabels::default(),
        }
    }
}

/// Status tone of a device, same mapping as the frontend `deviceTone`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Success,
    Warning,
    Error,
    Info,
    Neutral,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Screenshot,
    Open,
    Quit,
}

impl Action {
    pub fn id(self) -> &'static str {
        match self {
            Self::Screenshot => "screenshot",
            Self::Open => "open",
            Self::Quit => "quit",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Item {
    Device {
        serial: String,
        label: String,
        tone: Tone,
    },
    /// Disabled line of text.
    Note(String),
    Separator,
    Action {
        action: Action,
        label: String,
        enabled: bool,
    },
}

/// Prefix of device menu item ids; the serial follows.
pub const DEVICE_ID_PREFIX: &str = "device:";

/// What a clicked menu item id stands for.
#[derive(Debug, PartialEq, Eq)]
pub enum MenuChoice<'a> {
    Device(&'a str),
    Action(Action),
}

pub fn parse_menu_id(id: &str) -> Option<MenuChoice<'_>> {
    if let Some(serial) = id.strip_prefix(DEVICE_ID_PREFIX) {
        return Some(MenuChoice::Device(serial));
    }
    [Action::Screenshot, Action::Open, Action::Quit]
        .into_iter()
        .find(|a| a.id() == id)
        .map(MenuChoice::Action)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayView {
    pub tooltip: String,
    /// A device is connected and authorized: the icon gets its dot.
    pub online: bool,
    pub items: Vec<Item>,
}

/// `DeviceState` as the frontend spells its `kind`.
pub fn state_key(state: &DeviceState) -> &'static str {
    match state {
        DeviceState::Device => "device",
        DeviceState::Unauthorized => "unauthorized",
        DeviceState::Authorizing => "authorizing",
        DeviceState::Offline => "offline",
        DeviceState::Connecting => "connecting",
        DeviceState::NoPermissions => "no_permissions",
        DeviceState::Recovery => "recovery",
        DeviceState::Rescue => "rescue",
        DeviceState::Sideload => "sideload",
        DeviceState::Bootloader => "bootloader",
        DeviceState::Host => "host",
        DeviceState::Unknown(_) => "unknown",
    }
}

fn tone(state: &DeviceState) -> Tone {
    match state {
        DeviceState::Device => Tone::Success,
        DeviceState::Unauthorized | DeviceState::Authorizing | DeviceState::NoPermissions => {
            Tone::Warning
        }
        DeviceState::Offline => Tone::Error,
        DeviceState::Connecting
        | DeviceState::Recovery
        | DeviceState::Rescue
        | DeviceState::Sideload
        | DeviceState::Bootloader => Tone::Info,
        DeviceState::Host | DeviceState::Unknown(_) => Tone::Neutral,
    }
}

fn state_label(labels: &TrayLabels, state: &DeviceState) -> String {
    let key = state_key(state);
    if let Some(label) = labels.states.get(key) {
        return label.clone();
    }
    match state {
        DeviceState::Device => "Online".into(),
        DeviceState::Unknown(raw) => raw.clone(),
        _ => key.replace('_', " "),
    }
}

fn name_of<'a>(device: &'a Device, config: &'a TrayConfig) -> &'a str {
    config
        .names
        .get(&device.serial)
        .map(String::as_str)
        .or(device.model.as_deref())
        .unwrap_or(&device.serial)
}

fn truncate(text: String, max: usize) -> String {
    if text.chars().count() <= max {
        return text;
    }
    let mut out: String = text.chars().take(max - 1).collect();
    out.push('…');
    out
}

/// Renders the menu and tooltip: one line per device (dot + name + state),
/// "Screenshot of <selected>" when it is ready, then Open and Quit.
pub fn render(devices: &[Device], config: &TrayConfig) -> TrayView {
    let labels = &config.labels;
    let mut items = Vec::with_capacity(devices.len() + 5);
    let mut tooltip = String::from("Tether");

    if devices.is_empty() {
        items.push(Item::Note(labels.no_devices.clone()));
        tooltip.push_str(" — ");
        tooltip.push_str(&labels.no_devices);
    }
    for device in devices {
        let line = format!(
            "{} — {}",
            name_of(device, config),
            state_label(labels, &device.state)
        );
        tooltip.push('\n');
        tooltip.push_str(&line);
        items.push(Item::Device {
            serial: device.serial.clone(),
            label: line,
            tone: tone(&device.state),
        });
    }

    let target = config
        .selected
        .as_ref()
        .and_then(|serial| devices.iter().find(|d| &d.serial == serial))
        .filter(|d| d.state == DeviceState::Device);
    items.push(Item::Separator);
    items.push(Item::Action {
        action: Action::Screenshot,
        label: match target {
            Some(device) => labels
                .screenshot_of
                .replace("{name}", name_of(device, config)),
            None => labels.screenshot.clone(),
        },
        enabled: target.is_some(),
    });
    items.push(Item::Separator);
    items.push(Item::Action {
        action: Action::Open,
        label: labels.open.clone(),
        enabled: true,
    });
    items.push(Item::Action {
        action: Action::Quit,
        label: labels.quit.clone(),
        enabled: true,
    });

    TrayView {
        tooltip: truncate(tooltip, TOOLTIP_MAX),
        online: devices.iter().any(|d| d.state == DeviceState::Device),
        items,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adb::devices::parse_devices;

    fn devices() -> Vec<Device> {
        parse_devices(
            "emulator-5554 device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 transport_id:2\n\
             192.168.1.42:37115 unauthorized transport_id:3\n",
        )
    }

    #[test]
    fn lists_devices_with_names_states_and_tones() {
        let mut config = TrayConfig::default();
        config
            .names
            .insert("emulator-5554".into(), "Pixel 10 Pro".into());
        config
            .labels
            .states
            .insert("unauthorized".into(), "Unauthorized".into());
        let view = render(&devices(), &config);

        assert!(view.online);
        assert_eq!(
            view.items[..2],
            [
                Item::Device {
                    serial: "emulator-5554".into(),
                    label: "Pixel 10 Pro — Online".into(),
                    tone: Tone::Success,
                },
                Item::Device {
                    serial: "192.168.1.42:37115".into(),
                    label: "192.168.1.42:37115 — Unauthorized".into(),
                    tone: Tone::Warning,
                },
            ]
        );
        assert_eq!(
            view.tooltip,
            "Tether\nPixel 10 Pro — Online\n192.168.1.42:37115 — Unauthorized"
        );
    }

    #[test]
    fn screenshot_targets_the_selected_ready_device() {
        let mut config = TrayConfig {
            selected: Some("emulator-5554".into()),
            ..TrayConfig::default()
        };
        let screenshot = |view: &TrayView| {
            view.items
                .iter()
                .find_map(|item| match item {
                    Item::Action {
                        action: Action::Screenshot,
                        label,
                        enabled,
                    } => Some((label.clone(), *enabled)),
                    _ => None,
                })
                .unwrap()
        };

        let view = render(&devices(), &config);
        assert_eq!(
            screenshot(&view),
            ("Screenshot of sdk gphone64 arm64".into(), true)
        );

        // An unauthorized device cannot take screenshots.
        config.selected = Some("192.168.1.42:37115".into());
        let view = render(&devices(), &config);
        assert_eq!(screenshot(&view), ("Take screenshot".into(), false));
    }

    #[test]
    fn empty_list_shows_a_note_and_no_dot() {
        let view = render(&[], &TrayConfig::default());
        assert!(!view.online);
        assert_eq!(view.items[0], Item::Note("No devices connected".into()));
        assert_eq!(view.tooltip, "Tether — No devices connected");
    }

    #[test]
    fn long_tooltips_are_truncated() {
        let many = (0..20)
            .map(|i| format!("serial-number-{i:02} device transport_id:{i}\n"))
            .collect::<String>();
        let view = render(&parse_devices(&many), &TrayConfig::default());
        assert_eq!(view.tooltip.chars().count(), TOOLTIP_MAX);
        assert!(view.tooltip.ends_with('…'));
    }

    #[test]
    fn menu_ids_round_trip() {
        assert_eq!(
            parse_menu_id("device:192.168.1.42:5555"),
            Some(MenuChoice::Device("192.168.1.42:5555"))
        );
        assert_eq!(
            parse_menu_id(Action::Quit.id()),
            Some(MenuChoice::Action(Action::Quit))
        );
        assert_eq!(parse_menu_id("nope"), None);
    }

    #[test]
    fn config_accepts_partial_json() {
        let config: TrayConfig =
            serde_json::from_str(r#"{"closeToTray":true,"labels":{"open":"Открыть Tether"}}"#)
                .unwrap();
        assert!(config.visible);
        assert!(config.close_to_tray);
        assert_eq!(config.labels.open, "Открыть Tether");
        assert_eq!(config.labels.quit, "Quit Tether");
    }
}
