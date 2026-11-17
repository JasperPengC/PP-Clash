//! 内核下载的信任边界：官方摘要、平台格式、验证后原子发布。
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

pub const MAX_BINARY_BYTES: u64 = 256 * 1024 * 1024;
pub const PREVIEW_TAG: &str = "Prerelease-Alpha";

#[derive(Clone, serde::Deserialize)]
pub struct GhAsset {
    pub name: String,
    pub browser_download_url: String,
    pub digest: Option<String>,
}

#[derive(Clone, Copy)]
pub struct Target {
    os: &'static str,
    arch: &'static str,
}

impl Target {
    pub fn new(os: &str, arch: &str) -> Result<Self, String> {
        let os = match os {
            "macos" => "darwin",
            "windows" => "windows",
            "linux" => "linux",
            _ => return Err(format!("暂不支持当前内核平台：{os}")),
        };
        let arch = match arch {
            "x86_64" => "amd64",
            "aarch64" => "arm64",
            _ => return Err(format!("暂不支持当前内核架构：{arch}")),
        };
        Ok(Self { os, arch })
    }

    pub fn current() -> Result<Self, String> {
        Self::new(std::env::consts::OS, std::env::consts::ARCH)
    }

    pub fn binary_name(self) -> &'static str {
        if self.os == "windows" {
            "mihomo.exe"
        } else {
            "mihomo"
        }
    }

    fn extension(self) -> &'static str {
        if self.os == "windows" {
            "zip"
        } else {
            "gz"
        }
    }
}

fn valid_tag(tag: &str) -> bool {
    tag == PREVIEW_TAG || (tag.starts_with('v')
        && tag.len() > 1
        && tag.len() <= 100
        && tag[1..].starts_with(|c: char| c.is_ascii_digit())
        && tag
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".-_".contains(&c)))
}

fn alpha_build(name: &str, target: Target) -> Option<&str> {
    for variant in ["", "-compatible"] {
        let prefix = format!("mihomo-{}-{}{variant}-alpha-", target.os, target.arch);
        if let Some(build) = name.strip_prefix(&prefix).and_then(|tail| tail.strip_suffix(&format!(".{}", target.extension()))) {
            if (7..=40).contains(&build.len()) && build.bytes().all(|c| c.is_ascii_hexdigit()) { return Some(build); }
        }
    }
    None
}

pub fn cache_tag(tag: &str, asset: &GhAsset, target: Target) -> Result<String, String> {
    if tag == PREVIEW_TAG {
        let build = alpha_build(&asset.name, target).ok_or("预览版资产与当前平台不符")?;
        let digest = trusted_digest(asset, tag)?;
        return Ok(format!("alpha-{build}-{}", &digest[..16]));
    }
    if !valid_tag(tag) { return Err("内核版本标记无效".into()); }
    Ok(tag.to_string())
}

pub fn select_asset<'a>(
    assets: &'a [GhAsset],
    tag: &str,
    target: Target,
) -> Result<&'a GhAsset, String> {
    if !valid_tag(tag) {
        return Err("官方内核版本标记无效".into());
    }
    // 普通 amd64 资产可能要求较新的 CPU 指令集，优先与安装包一致的兼容版本。
    let variants = if target.arch == "amd64" { ["-compatible", ""] } else { ["", "-compatible"] };
    if tag == PREVIEW_TAG {
        for variant in variants {
            let prefix = format!("mihomo-{}-{}{variant}-alpha-", target.os, target.arch);
            if let Some(asset) = assets.iter().find(|asset| asset.name.starts_with(&prefix) && alpha_build(&asset.name, target).is_some()) {
                return Ok(asset);
            }
        }
        return Err("没有找到适用于当前平台的官方预览版".to_string());
    }
    // 只匹配完整版本；不接受其它 OS、Go 变体或另一个版本的相似前缀。
    for variant in variants {
        let name = format!(
            "mihomo-{}-{}{variant}-{tag}.{}",
            target.os,
            target.arch,
            target.extension()
        );
        if let Some(asset) = assets.iter().find(|asset| asset.name == name) {
            return Ok(asset);
        }
    }
    Err(format!(
        "没有找到 {}-{} 的官方内核资产",
        target.os, target.arch
    ))
}

pub fn trusted_digest(asset: &GhAsset, tag: &str) -> Result<String, String> {
    let official = format!(
        "https://github.com/MetaCubeX/mihomo/releases/download/{tag}/{}",
        asset.name
    );
    if !valid_tag(tag) || asset.browser_download_url != official {
        return Err("内核资产不是官方发布地址".into());
    }
    let digest = asset
        .digest
        .as_deref()
        .and_then(|d| d.strip_prefix("sha256:"))
        .filter(|d| d.len() == 64 && d.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or("官方发布元数据缺少有效 SHA-256 摘要，已拒绝下载")?;
    Ok(digest.to_ascii_lowercase())
}

pub fn read_bounded(reader: impl Read) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_BINARY_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取内核失败：{e}"))?;
    if bytes.len() as u64 > MAX_BINARY_BYTES {
        return Err("内核文件超过大小上限".into());
    }
    Ok(bytes)
}

pub fn validate_binary(bytes: &[u8], target: Target) -> Result<(), String> {
    let invalid = || "内核二进制平台、架构或文件格式不匹配".to_string();
    if target.os == "darwin" {
        let cpu = if target.arch == "amd64" {
            0x01000007u32
        } else {
            0x0100000c
        };
        if bytes.len() < 32
            || bytes[..4] != 0xfeedfacfu32.to_le_bytes()
            || bytes[4..8] != cpu.to_le_bytes()
            || bytes[12..16] != 2u32.to_le_bytes()
        {
            return Err(invalid());
        }
    } else if target.os == "linux" {
        let machine = if target.arch == "amd64" { 62u16 } else { 183 };
        if bytes.len() < 64
            || &bytes[..7] != b"\x7fELF\x02\x01\x01"
            || ![2u16.to_le_bytes(), 3u16.to_le_bytes()].contains(&bytes[16..18].try_into().unwrap())
            || bytes[18..20] != machine.to_le_bytes()
            || bytes[20..24] != 1u32.to_le_bytes()
            || bytes[52..54] != 64u16.to_le_bytes()
        {
            return Err(invalid());
        }
    } else {
        if bytes.len() < 64 || &bytes[..2] != b"MZ" {
            return Err(invalid());
        }
        let offset = u32::from_le_bytes(bytes[60..64].try_into().unwrap()) as usize;
        let header = bytes
            .get(offset..)
            .filter(|h| h.len() >= 24 + 112)
            .ok_or_else(invalid)?;
        let machine = if target.arch == "amd64" {
            0x8664u16
        } else {
            0xaa64
        };
        let optional_len = u16::from_le_bytes(header[20..22].try_into().unwrap()) as usize;
        let flags = u16::from_le_bytes(header[22..24].try_into().unwrap());
        if &header[..4] != b"PE\0\0"
            || header[4..6] != machine.to_le_bytes()
            || optional_len < 112
            || header.len() < 24 + optional_len
            || header[24..26] != 0x20bu16.to_le_bytes()
            || flags & 2 == 0
            || flags & 0x2000 != 0
        {
            return Err(invalid());
        }
    }
    Ok(())
}

fn unpack(bytes: &[u8], target: Target) -> Result<Vec<u8>, String> {
    if target.os != "windows" {
        return read_bounded(flate2::read::GzDecoder::new(bytes));
    }
    let mut zip =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("读取内核 ZIP 失败：{e}"))?;
    if zip.len() != 1 {
        return Err("内核 ZIP 必须只含一个可执行文件".into());
    }
    let entry = zip.by_index(0).map_err(|e| e.to_string())?;
    let name = entry.name();
    if entry.is_dir()
        || entry.enclosed_name().is_none()
        || name.contains(['/', '\\'])
        || !name.starts_with("mihomo")
        || !name.ends_with(".exe")
        || entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
    {
        return Err("内核 ZIP 包含无效的可执行文件路径".into());
    }
    read_bounded(entry)
}

pub fn is_verified_version(dir: &Path, target: Target) -> bool {
    let Ok(expected) = std::fs::read_to_string(dir.join(".verified-sha256")) else {
        return false;
    };
    let Ok(file) = std::fs::File::open(dir.join(target.binary_name())) else {
        return false;
    };
    let Ok(bytes) = read_bounded(file) else {
        return false;
    };
    validate_binary(&bytes, target).is_ok() && expected == format!("{:x}", Sha256::digest(&bytes))
}

pub fn install_verified(
    root: &Path,
    tag: &str,
    asset: &GhAsset,
    payload: &[u8],
    target: Target,
) -> Result<PathBuf, String> {
    let digest = trusted_digest(asset, tag)?;
    if payload.len() as u64 > MAX_BINARY_BYTES || format!("{:x}", Sha256::digest(payload)) != digest
    {
        return Err("内核 SHA-256 校验失败，未安装下载内容".into());
    }
    let bytes = unpack(payload, target)?;
    validate_binary(&bytes, target)?;
    let dest = root.join(cache_tag(tag, asset, target)?);
    if dest.exists() {
        if is_verified_version(&dest, target) {
            return Ok(dest.join(target.binary_name()));
        }
        return Err("同版本目录已有未验证内核，请移除后重新下载".into());
    }
    std::fs::create_dir_all(root).map_err(|e| format!("创建内核目录失败：{e}"))?;
    let stage = tempfile::Builder::new()
        .prefix(".download-")
        .tempdir_in(root)
        .map_err(|e| e.to_string())?;
    let binary = stage.path().join(target.binary_name());
    let mut file = std::fs::File::create(&binary).map_err(|e| e.to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("保存内核失败：{e}"))?;
    drop(file);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }
    std::fs::write(
        stage.path().join(".verified-sha256"),
        format!("{:x}", Sha256::digest(&bytes)),
    )
    .map_err(|e| e.to_string())?;
    // 同一文件系统内的目录重命名，失败时 TempDir 自动清理，列表始终看不到半份内核。
    if let Err(error) = std::fs::rename(stage.path(), &dest) {
        if !is_verified_version(&dest, target) {
            return Err(format!("发布内核版本失败：{error}"));
        }
    }
    Ok(dest.join(target.binary_name()))
}

#[cfg(test)]
#[path = "kernel_asset_tests.rs"]
mod tests;
