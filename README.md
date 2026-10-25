<div align="center">

# 🔌 Tether

**A quiet, fast desktop GUI for Android Debug Bridge.**

Devices, screen mirroring, files, apps, logcat and shell in one keyboard-first window. No more copy-pasting `adb` commands.

[![CI](https://github.com/kewldan/adb-gui/actions/workflows/ci.yml/badge.svg)](https://github.com/kewldan/adb-gui/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-6D5AE6.svg)](LICENSE)
![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-3DD68C)
![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24C8DB)

<!-- 📸 Hero screenshot / GIF goes here: docs/media/hero.png -->

</div>

> [!NOTE]
> 🚧 Tether is in early development. Features below marked ✅ work today; the rest are being built right now.

## ✨ Highlights

- 📦 **Zero setup.** Already have adb? Tether finds it. Don't have it? One click downloads the official platform-tools straight from Google into the app. Nothing is installed system-wide.
- 🤝 **Plays nice with your tools.** Tether talks to the standard adb server, so Android Studio, scrcpy and your terminal keep working side by side. No fighting over USB.
- ⚡ **Native and tiny.** Built with Tauri and Rust: a small binary with low memory use, not another 200 MB Electron app.
- ⌨️ **Keyboard-first.** `⌘K` / `Ctrl+K` command palette for every action, device and screen.
- 🧠 **Speaks adb natively.** Uses the adb server protocol directly instead of scraping CLI output, so it stays fast and reliable.
- 🎨 **Designed, not assembled.** A dense, calm interface with real dark and light themes, spring animations and accessible contrast.
- 🌍 **English and Russian** out of the box.

## 🧰 Features

| | Feature | What you get |
|---|---|---|
| ✅ | **Devices** | Live device list over USB, Wi-Fi and emulators, with clear states (unauthorized, offline, no permissions…) |
| ✅ | **adb setup** | Auto-detection of existing adb plus one-click platform-tools download with license consent |
| 🚧 | **Wi-Fi pairing** | Pair Android 11+ devices with a QR code or pairing code, or connect by IP |
| 🚧 | **Screen mirroring** | Low-latency mirroring and control powered by scrcpy-server |
| 🚧 | **File manager** | Browse, preview, drag & drop, and push/pull with a transfer queue |
| 🚧 | **Apps** | Install APK / split APKs on several devices at once, manage permissions, clear data, extract APKs |
| 🚧 | **Logcat** | A log viewer that keeps up: level, tag, package and regex filters, crash detection |
| 🚧 | **Shell** | Multi-tab terminal with snippets and run-on-all-devices |
| 🚧 | **Device overview** | Battery, storage, memory, CPU, display and network at a glance |
| 🚧 | **Developer toggles** | Dark mode, animation scales, DPI, layout bounds, demo mode, with one-click revert |
| 🚧 | **Power tools** | Port forwarding, intents & deep links, performance charts, bugreports, captures gallery |
| 🚧 | **Diagnostics** | "Can't see your device?" checklist that explains and fixes common problems |

## 📸 Screenshots

<!-- Screenshots and GIFs coming soon:
     docs/media/overview.png · docs/media/logcat.gif · docs/media/files.gif · docs/media/mirror.gif -->

_Coming soon._

## 🚀 Getting started

Tether is not packaged for release yet. To try it, build it from source (see below).

On first launch Tether looks for an existing adb (PATH, `ANDROID_HOME`, the Android Studio SDK, Homebrew, scoop, winget). If none is found, it offers to download the official platform-tools for you.

**Prepare your phone:** enable *Developer options* (tap *Build number* 7 times), turn on *USB debugging*, connect the cable and approve the RSA prompt.

> [!TIP]
> On Linux, install udev rules (`android-udev-rules` or your distro's equivalent) so non-root users can access the device.

## 🛠️ Development

**Prerequisites:** [Rust](https://rustup.rs) (stable), [Bun](https://bun.sh), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
bun install
bun run tauri dev     # run the app
bun run dev           # UI only, in the browser, with a mocked backend
bun run lint          # Biome
bun run build         # type-check and build the frontend
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings
```

### 🏗️ Tech stack

- **Shell:** [Tauri 2](https://tauri.app) + Rust (`tokio`) speaking the adb server protocol on `localhost:5037`
- **UI:** React 19, TypeScript, Tailwind CSS v4, [shadcn/ui](https://ui.shadcn.com) on Base UI, Motion
- **Mirroring:** [scrcpy-server](https://github.com/Genymobile/scrcpy) + WebCodecs
- **Tooling:** Bun, Biome, Vite

## 📄 License

[MIT](LICENSE) © kewldan

Android platform-tools are not bundled. When you choose to download them, they come directly from Google under the Android SDK License Agreement.
