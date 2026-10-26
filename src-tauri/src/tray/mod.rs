//! Menu bar (macOS) and system tray (Windows, Linux) icon.
//!
//! The menu lists the connected devices with their state, "Screenshot of
//! <current device>", Open and Quit. It is rebuilt here from the device
//! tracker (`commands::devices::watch_devices` calls [`set_devices`]), so it
//! stays live while the window is hidden. What only the webview knows —
//! display names, the selected device, localized labels, preferences —
//! arrives through `tray_sync`; clicks that need the webview go back
//! through the `tray_watch` channel.
//!
//! Icons: on macOS the template image `icons/tray@2x.png` (the system tints
//! it), with an alpha-only dot while a device is online. Windows and Linux
//! have no template images and their trays can be light or dark, so they
//! get the app's own small icon (the Iris glyph from `icon.ico` on Windows,
//! the tile on Linux), which reads on both, with a green dot.

mod icon;
pub mod view;

use std::sync::Mutex;

use serde::Serialize;
use tauri::image::Image;
use tauri::ipc::Channel;
use tauri::menu::{IconMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, Window, WindowEvent};

use crate::adb::devices::Device;
use crate::state::lock;
use view::{Action, DEVICE_ID_PREFIX, Item, MenuChoice, TrayConfig, TrayView};

const TRAY_ID: &str = "tether";
const MAIN_WINDOW: &str = "main";
/// macOS menu bar icons are template images; elsewhere the icon is colored.
const TEMPLATE: bool = cfg!(target_os = "macos");
/// Menu item dot bitmap: 32 px shown at 16 pt, so the dot is 7 pt.
const DOT_CANVAS: u32 = 32;
const DOT_DIAMETER: f32 = 14.0;

/// Menu clicks the webview acts on.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum TrayEvent {
    /// A device line was clicked; the window is already shown.
    SelectDevice { serial: String },
    /// "Screenshot of …": saved by the webview like the Overview button.
    Screenshot { serial: String },
}

#[derive(Default)]
struct Model {
    devices: Vec<Device>,
    config: TrayConfig,
    /// Set by the first `tray_sync`. The icon appears only after it, so a
    /// "hide the icon" preference never flashes it at startup.
    synced: bool,
}

/// What the native tray currently shows.
#[derive(Default)]
struct Applied {
    view: Option<TrayView>,
    visible: bool,
}

/// Tray model and the webview's event channel.
///
/// Lock order: `applied` before `model`. `model` is never held while
/// waiting for the main thread (menus are built there), because menu and
/// window handlers on the main thread lock it.
#[derive(Default)]
pub struct TrayState {
    model: Mutex<Model>,
    applied: Mutex<Applied>,
    events: Mutex<Option<Channel<TrayEvent>>>,
}

impl TrayState {
    /// Replaces the channel menu clicks are sent to.
    pub fn watch(&self, channel: Channel<TrayEvent>) {
        *lock(&self.events) = Some(channel);
    }

    fn emit(&self, event: TrayEvent) {
        let mut events = lock(&self.events);
        if let Some(channel) = events.as_ref()
            && channel.send(event).is_err()
        {
            *events = None;
        }
    }

    fn close_to_tray(&self) -> bool {
        let model = lock(&self.model);
        model.synced && model.config.visible && model.config.close_to_tray
    }
}

/// New device list from the tracker.
pub fn set_devices(app: &AppHandle, devices: &[Device]) {
    let state = app.state::<TrayState>();
    {
        let mut model = lock(&state.model);
        if model.devices == devices {
            return;
        }
        model.devices = devices.to_vec();
    }
    let _ = refresh(app);
}

/// New names, labels and preferences from the webview.
pub fn sync(app: &AppHandle, config: TrayConfig) -> tauri::Result<()> {
    let state = app.state::<TrayState>();
    {
        let mut model = lock(&state.model);
        model.config = config;
        model.synced = true;
    }
    refresh(app)
}

/// Brings the main window back from hidden, minimized or behind others.
pub fn show_main_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.show();
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// "Close to tray": closing the main window hides it while the tray icon
/// is there to bring it back.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event
        && window.label() == MAIN_WINDOW
        && window.state::<TrayState>().close_to_tray()
    {
        api.prevent_close();
        let _ = window.hide();
    }
}

/// macOS: a click on the Dock icon brings a hidden window back.
pub fn on_run_event(app: &AppHandle, event: RunEvent) {
    #[cfg(target_os = "macos")]
    if let RunEvent::Reopen {
        has_visible_windows: false,
        ..
    } = event
    {
        show_main_window(app);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, event);
}

fn refresh(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<TrayState>();
    let mut applied = lock(&state.applied);
    let rendered = {
        let model = lock(&state.model);
        model.synced.then(|| {
            (
                view::render(&model.devices, &model.config),
                model.config.visible,
            )
        })
    };
    let Some((view, visible)) = rendered else {
        return Ok(());
    };

    match app.tray_by_id(TRAY_ID) {
        None if !visible => {}
        None => {
            build(app, &view)?;
            applied.view = Some(view);
            applied.visible = true;
        }
        Some(tray) => {
            if applied.visible != visible {
                tray.set_visible(visible)?;
                applied.visible = visible;
            }
            if visible && applied.view.as_ref() != Some(&view) {
                update(app, &tray, applied.view.as_ref(), &view)?;
                applied.view = Some(view);
            }
        }
    }
    Ok(())
}

fn build(app: &AppHandle, view: &TrayView) -> tauri::Result<()> {
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu(app, view)?)
        .tooltip(&view.tooltip)
        .icon_as_template(TEMPLATE)
        // Windows convention: left click opens the app, right click the menu.
        .show_menu_on_left_click(!cfg!(windows))
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if cfg!(windows)
                && let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = tray_icon(app, view.online) {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

fn update(
    app: &AppHandle,
    tray: &TrayIcon,
    previous: Option<&TrayView>,
    view: &TrayView,
) -> tauri::Result<()> {
    if previous.map(|p| &p.items) != Some(&view.items) {
        tray.set_menu(Some(menu(app, view)?))?;
    }
    if previous.map(|p| &p.tooltip) != Some(&view.tooltip) {
        tray.set_tooltip(Some(&view.tooltip))?;
    }
    if previous.map(|p| p.online) != Some(view.online) {
        tray.set_icon_with_as_template(tray_icon(app, view.online), TEMPLATE)?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn base_icon(_app: &AppHandle) -> Option<Image<'static>> {
    Some(tauri::include_image!("icons/tray@2x.png"))
}

#[cfg(not(target_os = "macos"))]
fn base_icon(app: &AppHandle) -> Option<Image<'static>> {
    app.default_window_icon().map(|i| i.clone().to_owned())
}

fn tray_icon(app: &AppHandle, online: bool) -> Option<Image<'static>> {
    let base = base_icon(app)?;
    if !online {
        return Some(base);
    }
    let color = if TEMPLATE {
        icon::TEMPLATE_INK
    } else {
        icon::ONLINE
    };
    Some(icon::with_badge(&base, color))
}

/// Windows reads `&` in menu texts as a mnemonic marker.
fn menu_text(text: &str) -> String {
    if cfg!(windows) {
        text.replace('&', "&&")
    } else {
        text.to_owned()
    }
}

fn menu(app: &AppHandle, view: &TrayView) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    for item in &view.items {
        match item {
            Item::Device {
                serial,
                label,
                tone,
            } => {
                let dot = icon::dot(DOT_CANVAS, DOT_DIAMETER, icon::tone_color(*tone));
                menu.append(&IconMenuItem::with_id(
                    app,
                    format!("{DEVICE_ID_PREFIX}{serial}"),
                    menu_text(label),
                    true,
                    Some(dot),
                    None::<&str>,
                )?)?;
            }
            Item::Note(text) => {
                menu.append(&MenuItem::new(app, menu_text(text), false, None::<&str>)?)?;
            }
            Item::Separator => menu.append(&PredefinedMenuItem::separator(app)?)?,
            Item::Action {
                action,
                label,
                enabled,
            } => {
                menu.append(&MenuItem::with_id(
                    app,
                    action.id(),
                    menu_text(label),
                    *enabled,
                    None::<&str>,
                )?)?;
            }
        }
    }
    Ok(menu)
}

fn on_menu(app: &AppHandle, id: &str) {
    let state = app.state::<TrayState>();
    match view::parse_menu_id(id) {
        Some(MenuChoice::Device(serial)) => {
            show_main_window(app);
            state.emit(TrayEvent::SelectDevice {
                serial: serial.to_owned(),
            });
        }
        Some(MenuChoice::Action(Action::Screenshot)) => {
            let selected = lock(&state.model).config.selected.clone();
            if let Some(serial) = selected {
                state.emit(TrayEvent::Screenshot { serial });
            }
        }
        Some(MenuChoice::Action(Action::Open)) => show_main_window(app),
        Some(MenuChoice::Action(Action::Quit)) => app.exit(0),
        None => {}
    }
}
