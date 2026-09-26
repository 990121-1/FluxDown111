//! Embed Windows PE version information into `fluxdown_nmh.exe`.

const WINDOWS_APP_ICON: &str = "../../assets/logo/app_icon.ico";

fn main() {
    #[cfg(windows)]
    embed_version_info();
}

#[cfg(windows)]
fn embed_version_info() {
    let mut res = winresource::WindowsResource::new();
    res.set_icon(WINDOWS_APP_ICON);
    res.set("CompanyName", "FluxDown");
    res.set("ProductName", "FluxDown");
    res.set(
        "FileDescription",
        "FluxDown Native Messaging Host (browser bridge)",
    );
    res.set("InternalName", "fluxdown_nmh");
    res.set("OriginalFilename", "fluxdown_nmh.exe");
    res.set(
        "LegalCopyright",
        "Copyright (C) 2026 FluxDown. All rights reserved.",
    );
    res.set("FileVersion", env!("CARGO_PKG_VERSION"));
    res.set("ProductVersion", env!("CARGO_PKG_VERSION"));
    if let Err(error) = res.compile() {
        println!("cargo:warning=fluxdown_nmh version resource failed: {error}");
    }
}
