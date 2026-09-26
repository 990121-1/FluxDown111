//! Inject the Cargo package version as the default FluxDown user-agent version.

fn main() {
    let version = std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "1.0".to_string());
    println!("cargo:rustc-env=FLUXDOWN_APP_VERSION={version}");
}
