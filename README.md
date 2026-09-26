<div align="center">

<img src="assets/logo/fluxdown_logo.png" alt="FluxDown" width="128" />

# FluxDown

A Rust-native download manager focused on an IDM-like Windows experience: native desktop UI, browser capture, media resolution, multi-protocol downloads, and tray residency.

[中文](README.zh-CN.md)

</div>

## Architecture

The active desktop stack is **Rust + GPUI**:

```text
Browser Extension -> fluxdown_nmh -> fluxdown-agent -> fluxdownd -> fluxdown_engine
                         ^
                         |
                 fluxdown-desktop (GPUI)
```

| Component | Purpose |
|---|---|
| `fluxdown-desktop` | GPUI desktop UI, settings, tray, download views |
| `fluxdown-agent` | local gateway, settings/state, NMH registration, daemon supervision |
| `fluxdownd` | download-engine host, plugins and managed components |
| `fluxdown_nmh` | Chrome/Edge/Firefox Native Messaging relay |
| `fluxDown/` | WXT + TypeScript browser extension |

For supported media sites, the extension asks the local resolver for formats. The bundled yt-dlp plugin can return separate video/audio tracks, which the engine downloads and muxes with ffmpeg.

## Repository layout

```text
crates/                 GPUI desktop UI
native/engine/          download engine
native/daemon/          fluxdownd
native/agent/           fluxdown-agent
native/nmh/             browser native host
native/protocol/        RPC DTOs and method names
native/api/             REST/MCP/aria2 API
native/server/          optional headless server
native/cli/             optional CLI
fluxDown/               browser extension
examples/plugins/ytdlp/ bundled media resolver
assets/                 fonts, icons, bundled components
installer/windows/      Windows installer
web/                    headless server Web UI
website/                project website/docs
userscript/             optional userscript client
```

The superseded Flutter/Rinf desktop/mobile wrappers, old hub host and obsolete updater were removed so there is only one desktop architecture.

## Fresh clone: Windows

Requirements: Git, Rust stable MSVC, Visual Studio Build Tools/Windows SDK, and Node.js 22+.

```powershell
git clone https://github.com/990121-1/FluxDown111.git
cd FluxDown111
cargo build --release -p fluxdown_ui_app --bin fluxdown-desktop
cargo build --release -p fluxdown_agent --bin fluxdown-agent
cargo build --release -p fluxdown_daemon --bin fluxdownd
cargo build --release -p fluxdown_nmh --bin fluxdown_nmh
```

Launch only:

```text
target\release\fluxdown-desktop.exe
```

The desktop client manages the agent/daemon automatically.

### Browser extension

```powershell
cd fluxDown
npm ci
npm run build
```

Load `fluxDown\.output\chrome-mv3` as an unpacked extension in Chrome/Edge developer mode.

### Installer

After building the release binaries:

```powershell
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\windows\setup.iss
```

## Validation

```powershell
cargo fmt --check
cargo check -p fluxdown_ui_app -p fluxdown_agent -p fluxdown_daemon -p fluxdown_nmh
cargo check -p fluxdown_server -p fluxdown_cli
npm --prefix fluxDown ci
npm --prefix fluxDown run build
```

The headless server, CLI, Web UI, userscript and NAS/Docker packaging remain because they are independent active features.

## License

GNU AGPL-3.0. See [LICENSE](LICENSE).
