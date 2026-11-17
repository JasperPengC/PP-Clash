//! 官方版本目录与本地版本边界。

use std::path::{Path, PathBuf};
use super::kernel_asset::{self, GhAsset, Target};

const RELEASES_API: &str = "https://api.github.com/repos/MetaCubeX/mihomo/releases";

#[derive(serde::Deserialize)]
pub(super) struct Release {
    pub tag_name: String,
    pub assets: Vec<GhAsset>,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub prerelease: bool,
    pub published_at: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelReleaseInfo {
    pub version: String,
    pub published_at: Option<String>,
}

fn stable_tag(tag: &str) -> bool {
    let Some(version) = tag.strip_prefix('v') else { return false; };
    let parts: Vec<_> = version.split('.').collect();
    tag.len() <= 100 && parts.len() == 3 && parts.iter().all(|part| !part.is_empty() && part.bytes().all(|c| c.is_ascii_digit()))
}

pub(super) fn release_endpoint(tag: Option<&str>) -> Result<String, String> {
    match tag {
        None => Ok(format!("{RELEASES_API}/latest")),
        Some(kernel_asset::PREVIEW_TAG) => Ok(format!("{RELEASES_API}/tags/{}", kernel_asset::PREVIEW_TAG)),
        Some(tag) if stable_tag(tag) => Ok(format!("{RELEASES_API}/tags/{tag}")),
        Some(_) => Err("请选择有效的官方稳定版本".into()),
    }
}

pub(super) fn catalog_endpoint(page: u32) -> Result<String, String> {
    if !(1..=100).contains(&page) { return Err("版本页码无效".into()); }
    Ok(format!("{RELEASES_API}?per_page=20&page={page}"))
}

pub(super) fn version_key(tag: &str) -> Vec<u64> {
    tag.trim_start_matches('v').split('.').map(|part| part.parse().unwrap_or(0)).collect()
}

pub(super) fn catalog(releases: Vec<Release>, target: Target) -> Vec<KernelReleaseInfo> {
    let mut items: Vec<_> = releases.into_iter().filter(|release| {
        !release.draft && !release.prerelease && stable_tag(&release.tag_name)
            && kernel_asset::select_asset(&release.assets, &release.tag_name, target)
                .and_then(|asset| kernel_asset::trusted_digest(asset, &release.tag_name)).is_ok()
    }).map(|release| KernelReleaseInfo { version: release.tag_name, published_at: release.published_at }).collect();
    items.sort_by_cached_key(|item| std::cmp::Reverse(version_key(&item.version)));
    items.dedup_by(|a, b| a.version == b.version);
    items
}

/// 只允许 kernels/<version>/<platform binary>，拒绝目录与二进制符号链接。
pub(super) fn managed_version_dir(root: &Path, binary: &Path, target: Target) -> Result<PathBuf, String> {
    let invalid = || "只能删除应用管理的本地内核版本".to_string();
    if binary.file_name().and_then(|name| name.to_str()) != Some(target.binary_name()) { return Err(invalid()); }
    let dir = binary.parent().ok_or_else(invalid)?;
    let tag = dir.file_name().and_then(|name| name.to_str()).ok_or_else(invalid)?;
    let alpha_cache = tag.strip_prefix("alpha-").and_then(|value| value.split_once('-'))
        .is_some_and(|(build, digest)| (7..=40).contains(&build.len()) && digest.len() == 16
            && build.bytes().chain(digest.bytes()).all(|c| c.is_ascii_hexdigit()));
    if (!stable_tag(tag) && !alpha_cache) || dir.parent() != Some(root) { return Err(invalid()); }
    if std::fs::symlink_metadata(dir).map_err(|e| e.to_string())?.file_type().is_symlink()
        || std::fs::symlink_metadata(binary).map_err(|e| e.to_string())?.file_type().is_symlink() { return Err(invalid()); }
    let real_root = root.canonicalize().map_err(|e| e.to_string())?;
    let real_dir = dir.canonicalize().map_err(|e| e.to_string())?;
    let real_binary = binary.canonicalize().map_err(|e| e.to_string())?;
    if real_dir.parent() != Some(real_root.as_path()) || real_binary.parent() != Some(real_dir.as_path()) { return Err(invalid()); }
    Ok(real_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn release_endpoint_rejects_path_and_query_injection() {
        for tag in ["../v1", "v1/../../latest", "v1?x=1", "alpha", "", "v1%2fother"] {
            assert!(release_endpoint(Some(tag)).is_err(), "{tag}");
        }
        assert!(release_endpoint(Some(kernel_asset::PREVIEW_TAG)).unwrap().ends_with("/tags/Prerelease-Alpha"));
        assert!(catalog_endpoint(0).is_err());
        assert!(catalog_endpoint(101).is_err());
        assert!(catalog_endpoint(2).unwrap().ends_with("page=2"));
        assert!(release_endpoint(None).unwrap().ends_with("/latest"));
        assert!(release_endpoint(Some("v1.20.0")).unwrap().ends_with("/tags/v1.20.0"));
    }
    #[test]
    fn versions_sort_numerically_instead_of_lexically() {
        let mut tags = ["1.9.0", "v1.10.0", "v1.10.2", "v1.10.12"];
        tags.sort_by_key(|tag| std::cmp::Reverse(version_key(tag)));
        assert_eq!(tags, ["v1.10.12", "v1.10.2", "v1.10.0", "1.9.0"]);
    }
    #[test]
    fn removal_only_accepts_managed_binary_in_an_immediate_version_directory() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("kernels");
        let target = super::super::kernel_asset::Target::current().unwrap();
        let dir = root.join("v1.20.0");
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join(target.binary_name());
        std::fs::write(&bin, b"fixture").unwrap();
        assert_eq!(managed_version_dir(&root, &bin, target).unwrap(), dir.canonicalize().unwrap());
        assert!(managed_version_dir(&root, &temp.path().join("bin/mihomo"), target).is_err());
        assert!(managed_version_dir(&root, &dir.join(".verified-sha256"), target).is_err());
        std::fs::create_dir_all(root.join("v2.0.0/nested")).unwrap();
        assert!(managed_version_dir(&root, &root.join("v2.0.0/nested/mihomo"), target).is_err());
    }
    #[test]
    fn catalog_filters_untrusted_and_incompatible_releases() {
        fn release(tag: &str, os: &str, digest: Option<String>) -> Release {
            let name = format!("mihomo-{os}-amd64-{tag}.gz");
            Release { tag_name: tag.into(), draft: false, prerelease: false, published_at: None,
                assets: vec![GhAsset { browser_download_url: format!("https://github.com/MetaCubeX/mihomo/releases/download/{tag}/{name}"), name, digest }] }
        }
        let digest = Some(format!("sha256:{}", "a".repeat(64)));
        let mut preview = release("v1.30.0", "darwin", digest.clone()); preview.prerelease = true;
        let mut redirected = release("v1.25.0", "darwin", digest.clone()); redirected.assets[0].browser_download_url = "https://example.com/core.gz".into();
        let records = catalog(vec![
            release("v1.9.0", "darwin", digest.clone()), release("v1.10.0", "darwin", digest.clone()),
            release("v1.10.0", "darwin", digest.clone()), release("v1.20.0", "linux", digest.clone()),
            release("v1.19.0", "darwin", None), preview, redirected,
        ], Target::new("macos", "x86_64").unwrap());
        assert_eq!(records.iter().map(|record| record.version.as_str()).collect::<Vec<_>>(), ["v1.10.0", "v1.9.0"]);
    }
    #[cfg(unix)]
    #[test]
    fn removal_rejects_symlinked_version_directories_and_binaries() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("kernels");
        let outside = temp.path().join("outside");
        let target = super::super::kernel_asset::Target::current().unwrap();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join(target.binary_name()), b"keep").unwrap();
        symlink(&outside, root.join("v1.0.0")).unwrap();
        assert!(managed_version_dir(&root, &root.join("v1.0.0").join(target.binary_name()), target).is_err());
        std::fs::create_dir(root.join("v2.0.0")).unwrap();
        symlink(outside.join(target.binary_name()), root.join("v2.0.0").join(target.binary_name())).unwrap();
        assert!(managed_version_dir(&root, &root.join("v2.0.0").join(target.binary_name()), target).is_err());
        assert!(outside.join(target.binary_name()).exists());
    }
}
