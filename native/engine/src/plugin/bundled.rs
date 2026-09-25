//! Built-in plugins shipped inside the engine binary.
//!
//! The yt-dlp resolver used to live only under `examples/plugins/ytdlp`, so normal
//! desktop builds did not install it.  Embed the three small text files at compile
//! time and materialize them into <data_dir>/plugins on startup.  This keeps the
//! normal PluginManager path unchanged while making YouTube support available on
//! first launch.

use std::path::Path;

use super::manifest::PluginManifest;

const YTDLP_ID: &str = "fluxdown@ytdlp";
const YTDLP_MANIFEST: &str =
    include_str!("../../../../examples/plugins/ytdlp/manifest.json");
const YTDLP_RESOLVE: &str =
    include_str!("../../../../examples/plugins/ytdlp/resolve.js");
const YTDLP_HOOKS: &str =
    include_str!("../../../../examples/plugins/ytdlp/hooks.js");

fn version_tuple(v: &str) -> (u64, u64, u64) {
    let mut it = v.trim().trim_start_matches('v').split('.');
    let parse = |x: Option<&str>| {
        x.unwrap_or("0")
            .split(|c: char| !c.is_ascii_digit())
            .next()
            .unwrap_or("0")
            .parse::<u64>()
            .unwrap_or(0)
    };
    (parse(it.next()), parse(it.next()), parse(it.next()))
}

/// Ensure the built-in yt-dlp resolver exists in the normal plugin directory.
///
/// Existing newer copies are preserved.  Missing/older copies are replaced
/// atomically enough for startup (write temp files then rename), while plugin
/// settings remain in SQLite and are therefore not lost.
pub async fn sync_bundled_plugins(root: &Path) -> Result<(), String> {
    tokio::fs::create_dir_all(root)
        .await
        .map_err(|e| format!("create plugin root failed: {e}"))?;

    let bundled = PluginManifest::parse(YTDLP_MANIFEST.as_bytes())
        .map_err(|e| format!("bundled ytdlp manifest invalid: {e}"))?;
    bundled
        .validate()
        .map_err(|e| format!("bundled ytdlp manifest validation failed: {e}"))?;

    let dest = root.join(YTDLP_ID);
    let installed_manifest = dest.join("manifest.json");
    let mut should_write = !installed_manifest.is_file();

    if !should_write {
        match tokio::fs::read(&installed_manifest).await {
            Ok(bytes) => match PluginManifest::parse(&bytes) {
                Ok(installed) => {
                    should_write =
                        version_tuple(&installed.version) < version_tuple(&bundled.version);
                }
                Err(_) => should_write = true,
            },
            Err(_) => should_write = true,
        }
    }

    if !should_write {
        return Ok(());
    }

    tokio::fs::create_dir_all(&dest)
        .await
        .map_err(|e| format!("create bundled ytdlp dir failed: {e}"))?;

    async fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
        let tmp = path.with_extension("fluxdown.tmp");
        tokio::fs::write(&tmp, content)
            .await
            .map_err(|e| format!("write {} failed: {e}", tmp.display()))?;
        if path.exists() {
            let _ = tokio::fs::remove_file(path).await;
        }
        tokio::fs::rename(&tmp, path)
            .await
            .map_err(|e| format!("replace {} failed: {e}", path.display()))
    }

    write_atomic(&dest.join("manifest.json"), YTDLP_MANIFEST).await?;
    write_atomic(&dest.join("resolve.js"), YTDLP_RESOLVE).await?;
    write_atomic(&dest.join("hooks.js"), YTDLP_HOOKS).await?;

    crate::log_info!(
        "[plugin] bundled {} {} installed/updated",
        bundled.identity,
        bundled.version
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::version_tuple;

    #[test]
    fn version_compare_tuple() {
        assert!(version_tuple("3.1.0") > version_tuple("3.0.9"));
        assert_eq!(version_tuple("v3.0.0"), (3, 0, 0));
    }
}
