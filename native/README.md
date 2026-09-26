# Native Rust crates

FluxDown's active desktop path is fully Rust-native:

```text
fluxdown-desktop (GPUI)
        |
        v
fluxdown-agent
        |
        v
fluxdownd
        |
        v
fluxdown_engine
```

Browser integration uses `fluxdown_nmh` as a Native Messaging relay into the agent.

Important crates:
- `engine`: download/database/protocol/plugin implementation.
- `daemon`: owns one engine instance for the desktop stack.
- `agent`: local gateway, preferences, NMH registration, daemon supervision.
- `nmh`: browser Native Messaging relay.
- `protocol`: shared Agent/Daemon RPC DTOs.
- `api`: REST/MCP/aria2-compatible API surface.
- `server`: optional headless host.
- `cli`: optional command-line client.

The legacy Flutter/Rinf `hub` host has been removed. New desktop work must not reintroduce UI or FFI logic into `engine`.
