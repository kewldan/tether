<div align="center">

<img alt="Tether app icon" src="src-tauri/icons/128x128@2x.png" width="112">

# Tether

**A quiet, fast desktop GUI for Android Debug Bridge.**

Devices, screen mirroring, files, apps, logcat and shell in one
keyboard-first window.

<p>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-yellow?style=for-the-badge"></a>
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB?style=for-the-badge&logo=tauri&logoColor=white">
  <img alt="Rust" src="https://img.shields.io/badge/Rust-2024-B7410E?style=for-the-badge&logo=rust&logoColor=white">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-149ECA?style=for-the-badge&logo=react&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=for-the-badge&logo=typescript&logoColor=white">
  <img alt="Tailwind CSS v4" src="https://img.shields.io/badge/Tailwind-v4-38BDF8?style=for-the-badge&logo=tailwindcss&logoColor=white">
</p>
<p>
  <img alt="macOS" src="https://img.shields.io/badge/macOS-ready-000000?style=for-the-badge&logo=apple&logoColor=white">
  <img alt="Windows" src="https://img.shields.io/badge/Windows-ready-0078D4?style=for-the-badge">
  <img alt="Linux" src="https://img.shields.io/badge/Linux-ready-FCC624?style=for-the-badge&logo=linux&logoColor=black">
  <img alt="Android adb" src="https://img.shields.io/badge/Android-adb-3DDC84?style=for-the-badge&logo=android&logoColor=white">
  <img alt="scrcpy" src="https://img.shields.io/badge/mirroring-scrcpy-6D5AE6?style=for-the-badge">
  <img alt="shadcn/ui" src="https://img.shields.io/badge/UI-shadcn%2Fui-111111?style=for-the-badge&logo=shadcnui&logoColor=white">
</p>
<p>
  <a href="https://github.com/kewldan/tether/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/kewldan/tether/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI"></a>
  <a href="https://github.com/kewldan/tether/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/kewldan/tether?style=flat-square&logo=github&label=release"></a>
  <a href="https://github.com/kewldan/tether/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/kewldan/tether/total?style=flat-square&logo=github"></a>
  <a href="https://github.com/kewldan/tether/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/kewldan/tether?style=flat-square&logo=github"></a>
  <a href="https://github.com/kewldan/tether/commits/main"><img alt="Last commit" src="https://img.shields.io/github/last-commit/kewldan/tether?style=flat-square"></a>
  <img alt="Code size" src="https://img.shields.io/github/languages/code-size/kewldan/tether?style=flat-square">
  <img alt="Bun" src="https://img.shields.io/badge/bun-1.x-000000?style=flat-square&logo=bun&logoColor=white">
  <img alt="Biome" src="https://img.shields.io/badge/lint-Biome-60A5FA?style=flat-square&logo=biome&logoColor=white">
  <a href="ROADMAP.md"><img alt="Roadmap" src="https://img.shields.io/badge/roadmap-ROADMAP.md-6D5AE6?style=flat-square"></a>
</p>

</div>

---

Every Android developer has a text file of `adb` commands to copy from:
pull this file, clear that app's data, forward that port, grep logcat for a
crash. Tether puts all of it in one window. Plug in a phone or start an
emulator, and every screen works straight away: no command to remember, no
serial number to type.

It runs on the standard adb server, so Android Studio, scrcpy and your
terminal keep working next to it.

<!-- 📸 Hero screenshot / GIF goes here: docs/media/hero.png -->

## ✨ Highlights

- 📦 **Zero setup.** Already have adb? Tether finds it. Don't have it? One
  click downloads the official platform-tools straight from Google into the
  app. Nothing is installed system-wide.
- 🤝 **Plays nice with your tools.** Tether talks to the standard adb
  server, so Android Studio, scrcpy and your terminal keep working side by
  side. No fighting over USB.
- ⚡ **Native and tiny.** Built with Tauri and Rust: a small binary with low
  memory use, not another 200 MB Electron app.
- ⌨️ **Keyboard-first.** `⌘K` / `Ctrl+K` command palette for every action,
  device and screen.
- 🧠 **Speaks adb natively.** Uses the adb server protocol directly instead
  of scraping CLI output, so it stays fast and reliable.
- 🎨 **Designed, not assembled.** A dense, calm interface with real dark and
  light themes, spring animations and accessible contrast.
- 🔄 **Updates itself.** Signed over-the-air updates: one click, and it
  restarts on the new version.
- 🌍 **English and Russian** out of the box.

## 🧰 Features

| | Feature | What you get |
|---|---|---|
| 📱 | **Devices** | Live device list over USB, Wi-Fi and emulators, with clear states (unauthorized, offline, no permissions…) |
| 📦 | **adb setup** | Auto-detection of existing adb, one-click platform-tools download with license consent, and a notice when Google ships a newer one |
| 📶 | **Wi-Fi pairing** | Pair Android 11+ devices with a QR code or pairing code, or connect by IP |
| 🖥️ | **Screen mirroring** | Low-latency mirroring and control powered by scrcpy-server, device audio, MP4 recording with sound, a pop-out window and saved defaults |
| 📁 | **File manager** | Browse, preview (with photo EXIF) and transfer with a queue, compressed when the device allows; computer ⇄ device panes, drag files in and out |
| 🧩 | **Apps** | Install APK / split APKs on several devices at once, manage permissions, clear data, extract APKs, signing certificates, per-app data usage |
| 📜 | **Logcat** | A log viewer that keeps up: level, tag, package and regex filters, crash detection |
| 💻 | **Shell** | Multi-tab terminal with snippets and run-on-all-devices |
| 📊 | **Device overview** | Battery, storage, memory, CPU, display and network at a glance |
| 🎛️ | **Developer toggles** | Dark mode, animation scales, DPI, layout bounds, demo mode, system and per-app language, saved profiles and one-click revert |
| 🧮 | **Multi-device grid** | Every connected screen side by side; install, run, tap and screenshot on all of them at once |
| 📲 | **Sideload OTA** | Flash an OTA zip from recovery with progress and safety checks |
| 🔔 | **Menu bar & notifications** | Device status in the menu bar or tray; alerts when devices connect or an app crashes |
| 🔧 | **Power tools** | Port forwarding with live connections, intents & deep links, performance charts, bugreports, captures gallery with annotations |
| 🩺 | **Diagnostics** | "Can't see your device?" checklist that explains and fixes common problems |
| ⌨️ | **Keyboard-first** | Command palette, rebindable shortcuts, open at login straight into the menu bar |

What comes next is in the [🗺️ roadmap](ROADMAP.md).

## 📸 Screenshots

<!-- Screenshots and GIFs coming soon:
     docs/media/overview.png · docs/media/logcat.gif · docs/media/files.gif · docs/media/mirror.gif -->

_Coming soon._

## 🚀 Getting started

```bash
brew trust kewldan/tap && brew install --cask kewldan/tap/tether   # macOS
winget install kewldan.Tether                                    # Windows
```

Or download the installer for your OS from the
[latest release](https://github.com/kewldan/tether/releases/latest), or
build from source (see below).

On first launch Tether looks for an existing adb (PATH, `ANDROID_HOME`, the
Android Studio SDK, Homebrew, scoop, winget). If none is found, it offers to
download the official platform-tools for you.

**Prepare your phone:** enable *Developer options* (tap *Build number* 7
times), turn on *USB debugging*, connect the cable and approve the RSA
prompt.

> [!TIP]
> On Linux, install udev rules (`android-udev-rules` or your distro's
> equivalent) so non-root users can access the device.

## 🛠️ Development

**Prerequisites:** [Rust](https://rustup.rs) (stable), [Bun](https://bun.sh),
and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for
your OS.

```bash
bun install
bun run tauri dev     # run the app
bun run dev           # UI only, in the browser, with a mocked backend
bun run lint          # Biome
bun run build         # type-check and build the frontend
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings
```

Releases and OTA updates are described in [docs/releasing.md](docs/releasing.md).

### 🏗️ Tech stack

- **Shell:** [Tauri 2](https://tauri.app) + Rust (`tokio`) speaking the adb
  server protocol on `localhost:5037`
- **UI:** React 19, TypeScript, Tailwind CSS v4,
  [shadcn/ui](https://ui.shadcn.com) on Base UI, Motion
- **Mirroring:** [scrcpy-server](https://github.com/Genymobile/scrcpy) +
  WebCodecs
- **Tooling:** Bun, Biome, Vite

## 📄 License

[MIT](LICENSE) © kewldan

Android platform-tools are not bundled. When you choose to download them,
they come directly from Google under the Android SDK License Agreement.
scrcpy-server is bundled under the Apache 2.0 license
([notice](src-tauri/resources/SCRCPY-NOTICE)).
