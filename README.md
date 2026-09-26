# FluxDown111

Windows 原生下載器，目標是提供接近 IDM 的下載體驗。

## 目前架構

```text
Chrome / Edge Extension (WXT + TypeScript)
        │ Native Messaging
        ▼
fluxdown_nmh.exe
        │
        ▼
fluxdown-agent.exe
        │
        ├─ Local API / Browser bridge
        ▼
fluxdownd.exe
        │
        ▼
Rust Download Engine
        ├─ HTTP / HTTPS / FTP
        ├─ BitTorrent / eD2K
        ├─ HLS / DASH
        ├─ yt-dlp resolver
        ├─ FFmpeg mux
        └─ SQLite state

fluxdown-desktop.exe
        │
        └─ Rust + GPUI desktop UI
```

## 主要目錄

| 路徑 | 用途 |
|---|---|
| `crates/app` | GPUI Windows Desktop |
| `crates/components` | 共用 UI 元件 |
| `crates/downloads` | 下載頁面 |
| `crates/settings` | 設定 |
| `crates/extensions` | 擴充套件 UI |
| `native/engine` | 核心下載引擎 |
| `native/daemon` | 下載 Daemon |
| `native/agent` | Desktop / Browser bridge |
| `native/nmh` | Chrome/Edge Native Messaging Host |
| `native/api` | 本機 API |
| `native/protocol` | IPC/API DTO |
| `native/engine-protocol` | Engine protocol |
| `fluxDown` | Chrome/Edge 擴充套件 |
| `examples/plugins/ytdlp` | 內建 yt-dlp resolver |
| `assets` | 圖示、字型、受管元件 |

## 全新 Clone 後一鍵建置 / 安裝

在 Windows 上，Clone 完只要執行根目錄的 `install-windows.ps1`：

```powershell
git clone https://github.com/990121-1/FluxDown111.git
cd FluxDown111
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
```

腳本會自動：

- 檢查 Rust、Node.js/npm 與 MSVC C++ Build Tools。
- 缺少 Rust / Node / MSVC 時，透過 `winget` 嘗試安裝。
- 建置 `fluxdown-desktop.exe`、`fluxdown-agent.exe`、`fluxdownd.exe`、`fluxdown_nmh.exe`。
- 建置 Chrome / Edge MV3 擴充套件。
- 安裝到 `%LOCALAPPDATA%\Programs\FluxDown`。
- 建立桌面與開始功能表捷徑。
- 啟動 FluxDown，讓 Agent 自動註冊 Native Messaging Host。
- 開啟瀏覽器擴充管理頁，並把擴充資料夾路徑複製到剪貼簿。

Chrome / Edge 對「未封裝擴充套件」不允許一般程式靜默側載，因此最後仍需在瀏覽器按一次「載入未封裝項目」，選擇：

```text
%LOCALAPPDATA%\Programs\FluxDown\extension
```

常用參數：

```powershell
# 同時打開 Chrome 與 Edge 擴充管理頁
.\install-windows.ps1 -Browser Both

# 重新清除編譯產物後完整建置
.\install-windows.ps1 -Clean

# 已確定環境齊全時，跳過工具檢查/安裝
.\install-windows.ps1 -SkipPrerequisites

# 只安裝，不自動啟動程式
.\install-windows.ps1 -NoLaunch
```

## 手動建置

需求：

- Rust stable x86_64-pc-windows-msvc
- Visual Studio Build Tools / MSVC
- Node.js 22+
- npm

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-windows.ps1
```

或手動：

```powershell
cargo build --release -p fluxdown_ui_app --bin fluxdown-desktop
cargo build --release -p fluxdown_agent --bin fluxdown-agent
cargo build --release -p fluxdown_daemon --bin fluxdownd
cargo build --release -p fluxdown_nmh --bin fluxdown_nmh

cd fluxDown
npm install
npm run build
```

主要產物：

```text
target/release/fluxdown-desktop.exe
target/release/fluxdown-agent.exe
target/release/fluxdownd.exe
target/release/fluxdown_nmh.exe
fluxDown/.output/chrome-mv3/
```

## 安裝瀏覽器擴充套件

Chrome：

1. 開啟 `chrome://extensions`
2. 開啟「開發人員模式」
3. 選「載入未封裝項目」
4. 選取 `fluxDown/.output/chrome-mv3`

Edge 使用 `edge://extensions`，步驟相同。

## YouTube / 串流下載流程

FluxDown 不只靠瀏覽器嗅探。影片頁面會交給本機 resolver，透過 yt-dlp 列出 2160p / 1440p / 1080p / 720p 等格式。對 YouTube 的 video-only 高畫質，FluxDown 會取得獨立音訊軌並由 FFmpeg 合併，避免產生無聲 MP4。

## 開發原則

- Windows GPUI Desktop 是目前主線。
- 不再維護 Flutter / Rinf 舊 UI。
- 不再維護 Android、iOS、macOS、Linux、NAS Server、官網等舊發布線。
- `target/`、`build/`、`fluxDown/.output/` 不提交 Git。
- 修改後至少執行：
  - `cargo fmt --check`
  - `cargo check -p fluxdown_ui_app -p fluxdown_agent -p fluxdown_daemon -p fluxdown_nmh --bins`
  - `npm run build --prefix fluxDown`

## License

AGPL-3.0。