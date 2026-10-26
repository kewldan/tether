# 🗺️ Roadmap

What Tether doesn't do yet. Everything listed in the README's feature table
already works; this is the work that comes next.

## 🚢 First release

- [ ] Publish `kewldan/tether` and cut `v0.1.0` through the release workflow
- [ ] Test on a real phone over USB and Wi-Fi pairing (QR and pairing code)
- [ ] Test the full app on Windows and Linux (titlebar, drivers, udev, WebKitGTK)
- [ ] End-to-end OTA update from one published release to the next
- [ ] Screenshots and GIFs for the README

## 📦 Distribution

- [ ] macOS code signing and notarization (Developer ID)
- [ ] Windows Authenticode signing (no SmartScreen warning)
- [ ] Homebrew cask, winget and Flathub packages
- [ ] Linux arm64 builds (Google ships no platform-tools there, so adb comes
      from the package manager)

## 🧪 Sketched in the design (P2)

- [x] **Multi-device grid:** run an action on every selected device at once
      and see all screens side by side
- [x] **Sideload OTA:** flash an OTA zip through `adb sideload` with progress
      and safety checks
- [x] **Developer profiles:** saved sets of toggles ("Store screenshots",
      "Performance test")

## 🖥️ Screen mirroring

- [ ] Record the mirrored screen to a file
- [ ] Pop-out picture-in-picture window
- [ ] Verify H.265 and AV1 decoding and audio playback inside the app

## 📁 Files

- [x] Two-pane mode: computer ⇄ device
- [x] Drag files out of the app onto the desktop
- [ ] EXIF details in the image preview
- [ ] Compressed transfers (adb `sendrecv_v2` with brotli/lz4/zstd)
- [x] One queue row per file for multi-file transfers

## 📦 Apps

- [ ] Signing certificate SHA-256 and issuer in the app details
- [ ] Launcher icons whose foreground is a vector drawable
- [ ] Per-app network usage (needs root over adb)

## 🧰 Device and tools

- [ ] Annotate captures (arrow, box, text, blur)
- [ ] Change the system language from Developer toggles
- [ ] Ports: connection count and the process holding a host port
- [ ] Shell history that also records lines edited with arrows or Tab
- [ ] Logcat on Android 6 and older (no `-v uid` there)

## ⚙️ App

- [ ] Editable keyboard shortcuts
- [ ] Open at login
- [ ] "New platform-tools available" notice
- [ ] Default mirroring settings
