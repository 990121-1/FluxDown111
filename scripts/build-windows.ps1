$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host "== FluxDown Rust release build =="
cargo build --release -p fluxdown_ui_app --bin fluxdown-desktop
cargo build --release -p fluxdown_agent --bin fluxdown-agent
cargo build --release -p fluxdown_daemon --bin fluxdownd
cargo build --release -p fluxdown_nmh --bin fluxdown_nmh

Write-Host "== Browser extension build =="
Push-Location (Join-Path $Root "fluxDown")
if (-not (Test-Path "node_modules")) {
    npm install
}
npm run build
Pop-Location

Write-Host ""
Write-Host "Build complete:"
Write-Host "  target\release\fluxdown-desktop.exe"
Write-Host "  target\release\fluxdown-agent.exe"
Write-Host "  target\release\fluxdownd.exe"
Write-Host "  target\release\fluxdown_nmh.exe"
Write-Host "  fluxDown\.output\chrome-mv3"
