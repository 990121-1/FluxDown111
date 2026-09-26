---
title: Installation
description: Install the current FluxDown GPUI desktop build on Windows.
section: getting-started
order: 1
---

# Installation

The current desktop release is the Rust + GPUI Windows client. The download engine, local agent and browser Native Messaging bridge ship beside the desktop executable.

## Windows

Requirements: Windows 10 64-bit or later, x64.

Release artifacts:
- **Installer** — `FluxDown-<version>-windows-x64-setup.exe`
- **Portable ZIP** — `FluxDown-<version>-windows-x64-portable.zip`

For the portable package, keep all four executables together and run `fluxdown-desktop.exe`. The included `portable` marker keeps application data beside the executable.

The installer and portable build are not code-signed, so SmartScreen may show an unknown-publisher warning.

## Browser extension

The desktop client registers the Native Messaging Host automatically. Install the FluxDown browser extension, then reload the target page. The extension talks to the local NMH -> agent -> daemon stack.

## Other platforms

The repository still contains the cross-platform Rust engine and independent headless server/CLI. The legacy Flutter macOS/Linux/Android application wrappers were removed when the desktop client moved to GPUI.

## Uninstalling

For the installer, use Windows Settings -> Apps. For a portable install, exit FluxDown from the tray and delete the extracted directory. Downloaded files are not removed.
