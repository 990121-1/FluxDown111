<div align="center">

<img src="assets/logo/fluxdown_logo.png" alt="FluxDown" width="128" />

# FluxDown

Rust 原生下載管理器，目標是提供接近 IDM 的 Windows 使用體驗：原生桌面 UI、瀏覽器嗅探、影音解析、多協議下載與系統匣常駐。

[English](README.md)

</div>

## 目前架構

桌面主鏈路已統一為 **Rust + GPUI**：

```text
瀏覽器擴充 -> fluxdown_nmh -> fluxdown-agent -> fluxdownd -> fluxdown_engine
                                ^
                                |
                        fluxdown-desktop (GPUI)
```

| 元件 | 作用 |
|---|---|
| `fluxdown-desktop.exe` | GPUI 桌面視窗、系統匣、設定、下載列表 |
| `fluxdown-agent.exe` | 本機 Gateway、Native Messaging、設定/狀態協調、Daemon 管理 |
| `fluxdownd.exe` | 下載核心宿主，載入 Engine、插件與元件 |
| `fluxdown_nmh.exe` | Chrome/Edge/Firefox Native Messaging 中繼 |
| `fluxDown/` | WXT + TypeScript 瀏覽器擴充 |

YouTube 等網站由本機 yt-dlp resolver 解析畫質；高畫質若是影音分離，Engine 會下載 video + audio 並由 ffmpeg 合併。

## Repo 結構

```text
crates/                 GPUI 桌面 UI
native/engine/          下載引擎
native/daemon/          fluxdownd
native/agent/           fluxdown-agent
native/nmh/             瀏覽器 Native Host
native/protocol/        RPC DTO / method
native/api/             REST/MCP/aria2 API
native/server/          可選 headless server
native/cli/             可選 CLI
fluxDown/               瀏覽器擴充
examples/plugins/ytdlp/ 內建 yt-dlp resolver
assets/                 字型、圖示、內建元件
installer/windows/      Windows 安裝器
web/                    Server Web UI
website/                官網/文件
userscript/             可選 userscript
```

舊 Flutter/Rinf 桌面與行動端 wrapper、舊 hub host、舊 updater 已移除，避免兩套 Desktop 架構並存。

## 全新 Clone 後建置

需求：Git、Rust stable MSVC、Visual Studio Build Tools/Windows SDK、Node.js 22+。

```powershell
git clone https://github.com/990121-1/FluxDown111.git
cd FluxDown111
cargo build --release -p fluxdown_ui_app --bin fluxdown-desktop
cargo build --release -p fluxdown_agent --bin fluxdown-agent
cargo build --release -p fluxdown_daemon --bin fluxdownd
cargo build --release -p fluxdown_nmh --bin fluxdown_nmh
```

只需要手動啟動：

```text
target\release\fluxdown-desktop.exe
```

Desktop 會自動管理 Agent / Daemon。

### Chrome / Edge 擴充

```powershell
cd fluxDown
npm ci
npm run build
```

在 `chrome://extensions` 或 `edge://extensions` 開啟開發人員模式，載入：

```text
fluxDown\.output\chrome-mv3
```

### Windows Installer

四個 Release EXE 建好後：

```powershell
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\windows\setup.iss
```

## 驗證

```powershell
cargo fmt --check
cargo check -p fluxdown_ui_app -p fluxdown_agent -p fluxdown_daemon -p fluxdown_nmh
cargo check -p fluxdown_server -p fluxdown_cli
npm --prefix fluxDown ci
npm --prefix fluxDown run build
```

Server / CLI / Web UI / userscript / NAS-Docker 打包仍保留，因為它們是獨立且仍有使用入口的功能。

## License

GNU AGPL-3.0，詳見 [LICENSE](LICENSE)。
