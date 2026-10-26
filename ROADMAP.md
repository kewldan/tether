# 🗺️ Roadmap

What Tether doesn't do yet. Everything listed in the README's feature table
already works; this is the work that comes next.

## 🚢 First release

- [ ] Test on a real phone over USB and Wi-Fi pairing (QR and pairing code)
- [ ] Test the full app on Windows and Linux (titlebar, drivers, udev, WebKitGTK)
- [ ] End-to-end OTA update from one published release to the next

## 📦 Distribution

- [ ] macOS code signing and notarization (Developer ID)
- [ ] Windows Authenticode signing (no SmartScreen warning)
- [ ] Get microsoft/winget-pkgs#462140 merged, then add `WINGET_TOKEN` for automatic updates
- [ ] Flathub package
- [ ] Linux arm64 builds (Google ships no platform-tools there, so adb comes
      from the package manager)
