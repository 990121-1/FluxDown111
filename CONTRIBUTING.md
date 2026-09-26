# Contributing

FluxDown's desktop client is Rust + GPUI. The old Flutter/Rinf stack has been removed.

## Setup

Install Rust stable (MSVC on Windows) and Node.js 22+.

```powershell
git clone https://github.com/990121-1/FluxDown111.git
cd FluxDown111
cargo check -p fluxdown_ui_app -p fluxdown_agent -p fluxdown_daemon -p fluxdown_nmh
npm --prefix fluxDown ci
npm --prefix fluxDown run build
```

## Before committing

```powershell
cargo fmt --check
cargo check -p fluxdown_ui_app -p fluxdown_agent -p fluxdown_daemon -p fluxdown_nmh
cargo check -p fluxdown_server -p fluxdown_cli
npm --prefix fluxDown run build
```

Use targeted tests for the crate or behavior you changed.

On Windows, exit FluxDown from the tray before replacing release binaries. The active boundary is:

```text
GPUI desktop -> agent -> daemon -> engine
browser extension -> NMH -> agent
```
