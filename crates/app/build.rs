//! 為 GPUI 桌面客戶端嵌入 Windows 程序資源。

const WINDOWS_APP_ICON: &str = "../../assets/logo/app_icon.ico";

fn main() -> std::io::Result<()> {
    println!("cargo:rerun-if-changed={WINDOWS_APP_ICON}");

    #[cfg(windows)]
    embed_windows_resources()?;

    Ok(())
}

/// 資源 ID 1 是 Windows Explorer 與 GPUI Windows 後端共同讀取的預設圖示。
#[cfg(windows)]
fn embed_windows_resources() -> std::io::Result<()> {
    let mut resources = winresource::WindowsResource::new();
    resources.set_icon(WINDOWS_APP_ICON);
    resources.set("CompanyName", "FluxDown");
    resources.set("ProductName", "FluxDown");
    resources.set("FileDescription", "FluxDown");
    resources.set("InternalName", "com.fluxdown.app");
    resources.set("OriginalFilename", "fluxdown-desktop.exe");
    resources.set(
        "LegalCopyright",
        "Copyright (C) 2026 FluxDown. All rights reserved.",
    );
    resources.compile()
}
