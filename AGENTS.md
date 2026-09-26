# FluxDown repository instructions

FluxDown is a Rust-native download manager. The active desktop architecture is:

```text
fluxdown-desktop (GPUI) -> fluxdown-agent -> fluxdownd -> fluxdown_engine
Browser extension -> fluxdown_nmh -> fluxdown-agent
```

The former Flutter/Rinf desktop/mobile stack and `native/hub` were removed and must not be reintroduced accidentally.

## Boundaries

- `native/engine`: download/database/protocol/plugin logic; keep it UI-agnostic.
- `native/daemon`: owns the engine for the desktop stack.
- `native/agent`: local gateway, preferences, NMH registration, daemon supervision.
- `native/protocol`: shared RPC DTOs/method names.
- `native/api`: REST/MCP/aria2 surface.
- `crates/*`: GPUI desktop presentation and interaction.
- `fluxDown/`: WXT browser extension.
- `examples/plugins/ytdlp`: bundled production resolver despite the examples path.
- `native/server`, `native/cli`, `web`: active independent products; do not treat them as desktop dead code.
- `userscript/`: active optional client for the takeover API.

## Media flow

```text
web page -> extension -> NMH -> agent -> daemon resolver -> yt-dlp/plugin
         -> quality list -> download request -> engine -> optional ffmpeg mux
```

For YouTube, high-resolution video-only formats must carry `audioUrl` into the download request so the engine can mux a playable MP4.

## Settings

Notifications live under General. Account, Diagnostics, About, and the standalone Notifications page were intentionally removed.

## Validation

```powershell
cargo fmt --check
cargo check -p fluxdown_ui_app -p fluxdown_agent -p fluxdown_daemon -p fluxdown_nmh
cargo check -p fluxdown_server -p fluxdown_cli
npm --prefix fluxDown ci
npm --prefix fluxDown run build
```

Build release binaries one by one on Windows to reduce peak linker memory and to make locked-executable failures obvious.

Never commit `target/`, `build/`, `fluxDown/.output/`, or `node_modules/`.
