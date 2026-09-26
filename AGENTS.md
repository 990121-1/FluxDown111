# AGENTS.md

FluxDown111 is now a Windows-first Rust/GPUI download manager.

## Active product path

- Desktop UI: `crates/app` and other `crates/*`
- Download engine: `native/engine`
- Desktop daemon: `native/daemon`
- Desktop/browser bridge: `native/agent`
- Native Messaging Host: `native/nmh`
- Shared API/protocol: `native/api`, `native/protocol`, `native/engine-protocol`
- Browser extension: `fluxDown`
- Built-in yt-dlp resolver: `examples/plugins/ytdlp`

Do not reintroduce the removed Flutter/Rinf mobile/server stack unless explicitly requested.

## Required checks

For Rust changes:

```powershell
cargo fmt --check
cargo check -p fluxdown_ui_app -p fluxdown_agent -p fluxdown_daemon -p fluxdown_nmh --bins
```

For extension changes:

```powershell
npm run build --prefix fluxDown
```

## Runtime model

`fluxdown-desktop.exe` launches/uses `fluxdown-agent.exe` and `fluxdownd.exe`.
The browser extension talks through `fluxdown_nmh.exe`.
YouTube format discovery is done by the local yt-dlp resolver, not by browser request sniffing alone.

Windows desktop must remain GUI subsystem / no console window. Closing the main window hides to the system tray; tray Exit performs full shutdown.
