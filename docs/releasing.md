# Releasing Tether

Tether ships over-the-air updates with
[tauri-plugin-updater](https://v2.tauri.app/plugin/updater/). Every release
is built by `.github/workflows/release.yml`, signed with the updater key and
published as a GitHub release in `kewldan/tether` together with
`latest.json`. Installed apps poll

```
https://github.com/kewldan/tether/releases/latest/download/latest.json
```

5 seconds after launch and every 6 hours, verify the signature against the
public key in `src-tauri/tauri.conf.json`, and offer "Install & restart".

## One-time setup

The updater key pair lives outside the repo:

| File | What it is |
|---|---|
| `~/.tauri/tether.key` | Private key (password-protected). **Never commit it.** |
| `~/.tauri/tether.key.password` | Its password |
| `~/.tauri/tether.key.pub` | Public key, already in `tauri.conf.json` |

> [!WARNING]
> Back up the private key and its password (e.g. in a password manager).
> If they are lost, installed copies can never be updated again: they only
> accept updates signed by this key.

Add two repository secrets (Settings → Secrets and variables → Actions):

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo kewldan/tether < ~/.tauri/tether.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo kewldan/tether < ~/.tauri/tether.key.password
```

## Cutting a release

1. Bump `version` in `package.json` (it is the single source of truth:
   `tauri.conf.json` reads it) and in `src-tauri/Cargo.toml`.
2. Commit: `chore(release): v0.2.0`.
3. Tag and push:
   ```bash
   git tag v0.2.0
   git push origin main v0.2.0
   ```
   The workflow fails early if the tag and `package.json` disagree.
4. Wait for the four builds (macOS arm64 and x64, Linux, Windows). They
   upload installers, `.sig` files and `latest.json` to a **draft** release.
5. Edit the draft: write release notes (they show up as the update's
   description), then **Publish**. Only published releases count as
   "latest", so nothing reaches users until this step.

## What users get

| Platform | Installer | OTA update |
|---|---|---|
| macOS | `.dmg` | `.app.tar.gz` |
| Windows | `.exe` (NSIS), `.msi` | NSIS installer, `passive` mode |
| Linux | `.AppImage`, `.deb`, `.rpm` | `.AppImage` only (deb/rpm update through the package) |

## Code signing

- **macOS:** without a Developer ID certificate the app is unsigned, so
  Gatekeeper blocks the first launch (right-click → Open). Once there is an
  Apple Developer account, add the `APPLE_*` secrets listed in
  `release.yml` and uncomment them to sign and notarize.
- **Windows:** unsigned installers trigger SmartScreen. An Authenticode
  certificate can be added later via `bundle.windows` in `tauri.conf.json`.

The updater signature above is independent of OS code signing and is
always required.
