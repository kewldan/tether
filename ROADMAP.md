# 🗺️ Roadmap

What Tether doesn't do yet. Everything listed in the README's feature table
already works; this is the work that comes next.

## 🚢 First release

- [ ] Cut `v0.1.0` through the release workflow
- [ ] Test on a real phone over USB and Wi-Fi pairing (QR and pairing code)
- [ ] Test the full app on Windows and Linux (titlebar, drivers, udev, WebKitGTK)
- [ ] End-to-end OTA update from one published release to the next
- [ ] Screenshots and GIFs for the README

## 📦 Distribution

- [ ] macOS code signing and notarization (Developer ID)
- [ ] Windows Authenticode signing (no SmartScreen warning)
- [ ] First winget submission after `v0.1.0` (`komac new`, see docs/releasing.md)
- [ ] Flathub package
- [ ] Linux arm64 builds (Google ships no platform-tools there, so adb comes
      from the package manager)

## 🖥️ Screen mirroring

- [ ] Verify audio playback inside the app (H.265 and AV1 decoding verified
      in WebKit on macOS)
- [ ] Audio track in recordings (raw PCM is forwarded today; needs an AAC or
      Opus stream from the server)

## 📁 Files

- [ ] EXIF details in the image preview
- [ ] Compressed transfers (adb `sendrecv_v2` with brotli/lz4/zstd)

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

- [ ] Default mirroring settings
