//! 内置内核与 Geo 数据的自管理。
//!
//! PP Clash 不再借用其它客户端的内核：`src-tauri/resources/kernel.zip` 里带着
//! mihomo + GeoIP/GeoSite，首次启动解压到应用数据目录；TUN 需要 root 时，
//! 再把用户目录里的内核安装一份到 `/Library/Application Support/PPClash/bin`
//! （setuid root，只装一次，之后 TUN 启停不再弹密码）。

use std::path::{Path, PathBuf};

#[path = "kernel_asset.rs"]
mod kernel_asset;
#[path = "kernel_catalog.rs"]
mod kernel_catalog;
pub use kernel_catalog::KernelReleaseInfo;

pub(crate) static KERNEL_FILES_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub(crate) fn managed_kernel_version_dir(path: &Path) -> Result<PathBuf, String> {
    kernel_catalog::managed_version_dir(&data_dir()?.join("kernels"), path, Target::current()?)
}
use kernel_asset::Target;

use serde::Serialize;
use tauri::{AppHandle, Manager};

const KERNEL_ZIP: &str = "kernel.zip";

const GEO_FILES: [(&str, u64); 5] = [
    ("geosite.dat", 1_000_000),
    ("geoip.metadb", 1_000_000),
    ("geoip.dat", 1_000_000),
    ("country.mmdb", 100_000),
    ("ASN.mmdb", 1_000_000),
];

/// 应用数据目录（与旧版本一致，避免迁移订阅/设置）。
pub fn data_dir() -> Result<PathBuf, String> {
    crate::platform::data_dir()
}

pub fn log_path() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("kernel.log"))
}

pub fn system_bin_dir() -> PathBuf {
    crate::platform::system_bin_dir()
}

pub fn system_bin() -> PathBuf {
    crate::platform::system_bin()
}

fn resource_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        out.push(dir.join("resources"));
        out.push(dir);
    }
    // cargo run / 直接跑 target/debug 时 resource_dir 里没有资源，回落到仓库目录
    if let Some(manifest) = option_env!("CARGO_MANIFEST_DIR") {
        out.push(PathBuf::from(manifest).join("resources"));
    }
    out
}

fn zip_path(app: &AppHandle) -> Option<PathBuf> {
    resource_candidates(app)
        .into_iter()
        .map(|dir| dir.join(KERNEL_ZIP))
        .find(|p| p.is_file())
}

fn zip_entry(zip: &Path, entry: &str) -> Option<String> {
    let file = std::fs::File::open(zip).ok()?;
    let mut archive = zip::ZipArchive::new(file).ok()?;
    let mut entry = archive.by_name(entry).ok()?;
    let mut text = String::new();
    std::io::Read::read_to_string(&mut entry, &mut text).ok()?;
    let text = text.trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

pub fn bundled_version(app: &AppHandle) -> Option<String> {
    zip_path(app).and_then(|zip| zip_entry(&zip, "version.txt"))
}

fn geo_ok(dir: &Path) -> bool {
    GEO_FILES.iter().all(|(name, min)| {
        std::fs::metadata(dir.join(name))
            .map(|m| m.len() >= *min)
            .unwrap_or(false)
    })
}

fn check_bundle_directory(zip: &Path, start: u64, expected: usize) -> Result<(), String> {
    use std::io::{Read, Seek, SeekFrom};
    // zip::ZipArchive 会折叠完全同名的中央目录项，额外核对原始记录数。
    let mut reader = std::fs::File::open(zip).map_err(|e| e.to_string())?;
    reader
        .seek(SeekFrom::Start(start))
        .map_err(|e| e.to_string())?;
    let mut count = 0;
    loop {
        let mut signature = [0; 4];
        reader
            .read_exact(&mut signature)
            .map_err(|e| e.to_string())?;
        if signature == *b"PK\x05\x06" || signature == *b"PK\x06\x06" {
            break;
        }
        if signature != *b"PK\x01\x02" {
            return Err("内置资源中央目录无效".into());
        }
        count += 1;
        if count > expected {
            return Err("内置资源含重复中央目录项".into());
        }
        let mut header = [0; 42];
        reader.read_exact(&mut header).map_err(|e| e.to_string())?;
        let skip: i64 = [24, 26, 28]
            .iter()
            .map(|offset| {
                u16::from_le_bytes(header[*offset..*offset + 2].try_into().unwrap()) as i64
            })
            .sum();
        reader
            .seek(SeekFrom::Current(skip))
            .map_err(|e| e.to_string())?;
    }
    if count != expected {
        return Err("内置资源中央目录数量不一致".into());
    }
    Ok(())
}

fn extract(zip: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(zip).map_err(|e| format!("打开内置资源失败：{e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("读取内置资源失败：{e}"))?;
    check_bundle_directory(zip, archive.central_directory_start(), archive.len())?;
    let target = Target::current()?;
    let binary_name = format!("bin/{}", target.binary_name());
    let mut allowed = vec![binary_name.as_str(), "version.txt"];
    allowed.extend(GEO_FILES.iter().map(|(name, _)| *name));
    let mut seen = std::collections::HashSet::new();
    let mut total = 0u64;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|e| e.to_string())?;
        let name = entry.name();
        // 精确白名单同时排除 ./、重复斜线、Windows 末尾点/空格/盘符等路径别名。
        if (name != "bin/" && !allowed.contains(&name))
            || !seen.insert(name.trim_end_matches('/').to_ascii_lowercase())
            || entry.enclosed_name().is_none()
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
            || (name == "bin/" && (!entry.is_dir() || entry.size() != 0))
            || (name != "bin/" && entry.is_dir())
        {
            return Err("内置资源包含非规范、重复或白名单之外的路径".into());
        }
        total = total.checked_add(entry.size()).ok_or("内置资源大小无效")?;
        if total > 1024 * 1024 * 1024 || entry.size() > kernel_asset::MAX_BINARY_BYTES {
            return Err("内置资源超过解压大小上限".into());
        }
    }
    // 只向独立暂存目录写入精确成员；CRC/内容失败时目标目录保持原样。
    let parent = dest.parent().ok_or("内置资源目标目录无效")?;
    let staged = tempfile::Builder::new()
        .prefix(".bundle-")
        .tempdir_in(parent)
        .map_err(|e| e.to_string())?;
    std::fs::create_dir(staged.path().join("bin")).map_err(|e| e.to_string())?;
    for name in allowed {
        let entry = archive
            .by_name(name)
            .map_err(|_| format!("内置资源缺少文件：{name}"))?;
        let bytes = kernel_asset::read_bounded(entry)?;
        if name == "version.txt" {
            let version = std::str::from_utf8(&bytes).map_err(|_| "内置版本号无效")?;
            if bytes.len() > 1024
                || version.trim().is_empty()
                || version.to_ascii_lowercase().contains("placeholder")
            {
                return Err("内置版本号无效或为编译占位资源".into());
            }
        }
        std::fs::write(staged.path().join(name), bytes)
            .map_err(|e| format!("保存内置资源失败：{e}"))?;
    }
    let binary =
        std::fs::File::open(staged.path().join(&binary_name)).map_err(|e| e.to_string())?;
    kernel_asset::validate_binary(&kernel_asset::read_bounded(binary)?, target)?;
    if !geo_ok(staged.path()) {
        return Err("内置 Geo 数据不完整".into());
    }
    if dest.exists() {
        let metadata = std::fs::symlink_metadata(dest).map_err(|e| e.to_string())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("内置资源必须提取到独立空目录".into());
        }
        // remove_dir 仅允许空目录；不能覆盖任何现有文件或遗留数据。
        std::fs::remove_dir(dest).map_err(|_| "内置资源必须提取到独立空目录")?;
    }
    std::fs::rename(staged.path(), dest).map_err(|e| format!("发布内置资源失败：{e}"))?;
    Ok(())
}

/// 确保用户目录里有可用的内核 + Geo 数据，返回 (内核路径, 版本号)。
pub fn ensure_kernel(app: &AppHandle) -> Result<(PathBuf, String), String> {
    ensure_kernel_impl(app, false)
}

fn ensure_kernel_impl(app: &AppHandle, force: bool) -> Result<(PathBuf, String), String> {
    let dir = data_dir()?;
    let bin = dir.join("bin").join(crate::platform::kernel_binary_name());
    let version_file = dir.join("bin/.version");

    let zip = zip_path(app).ok_or_else(|| {
        "缺少内置内核资源 kernel.zip：请先运行 scripts/prepare-resources.sh 生成并重新构建"
            .to_string()
    })?;
    let want = zip_entry(&zip, "version.txt").ok_or("内置资源缺少有效版本号")?;
    let have = std::fs::read_to_string(&version_file)
        .ok()
        .map(|s| s.trim().to_string());

    let target = Target::current()?;
    let valid_bin = std::fs::File::open(&bin)
        .ok()
        .and_then(|file| kernel_asset::read_bounded(file).ok())
        .is_some_and(|bytes| kernel_asset::validate_binary(&bytes, target).is_ok());
    let up_to_date = !force && valid_bin && have.as_deref() == Some(want.as_str()) && geo_ok(&dir);
    if !up_to_date {
        // 先在隔离目录里完整验证，错误资源不能破坏已经安装的文件。
        let staged = tempfile::tempdir().map_err(|e| e.to_string())?;
        extract(&zip, staged.path())?;
        if !geo_ok(staged.path()) {
            return Err("内置 Geo 数据不完整，未写入版本标记".into());
        }
        std::fs::create_dir_all(dir.join("bin")).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&version_file);
        // 旧版本可能留下 root 属主的文件；验证成功后先删再复制。
        for (name, _) in GEO_FILES {
            let path = dir.join(name);
            let _ = std::fs::remove_file(&path);
            std::fs::copy(staged.path().join(name), &path)
                .map_err(|e| format!("安装 Geo 数据失败：{e}"))?;
        }
        let _ = std::fs::remove_file(&bin);
        std::fs::copy(staged.path().join("bin").join(target.binary_name()), &bin)
            .map_err(|e| format!("安装内置内核失败：{e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| e.to_string())?;
        }
        let installed = std::fs::File::open(&bin).map_err(|e| e.to_string())?;
        kernel_asset::validate_binary(&kernel_asset::read_bounded(installed)?, target)?;
        std::fs::write(&version_file, &want).map_err(|e| format!("写入内核版本失败：{e}"))?;
    }

    Ok((bin, want))
}

/// 安装/更新一份 setuid root 的系统内核，供 TUN 使用。
///
/// 只在 TUN 第一次启动或内核版本变化时调用，需要管理员授权一次。
pub fn ensure_system_kernel(user_bin: &Path, version: &str) -> Result<PathBuf, String> {
    install_system_kernel(user_bin, version, false)
}

#[cfg(target_os = "linux")]
fn install_system_kernel(user_bin: &Path, _version: &str, _force: bool) -> Result<PathBuf, String> {
    crate::linux::authorize_kernel(user_bin, false)
}

#[cfg(not(target_os = "linux"))]
fn install_system_kernel(user_bin: &Path, version: &str, force: bool) -> Result<PathBuf, String> {
    let dir = system_bin_dir();
    let dest = system_bin();
    let version_file = dir.join(".version");
    let have = std::fs::read_to_string(&version_file)
        .ok()
        .map(|s| s.trim().to_string());

    if !force && dest.is_file() && have.as_deref() == Some(version) {
        return Ok(dest);
    }

    let script = format!(
        "mkdir -p '{dir}' && cp '{src}' '{dst}' && chown root:wheel '{dst}' && chmod 4755 '{dst}' && printf '%s' '{ver}' > '{vf}'",
        dir = dir.display(),
        src = user_bin.display(),
        dst = dest.display(),
        ver = version,
        vf = version_file.display(),
    );
    let inner = script.replace('\\', "\\\\").replace('"', "\\\"");
    let osa = format!(
        "do shell script \"{}\" with administrator privileges",
        inner
    );

    let status = crate::platform::command("osascript")
        .arg("-e")
        .arg(&osa)
        .status()
        .map_err(|e| format!("调用系统授权失败：{e}"))?;

    if !status.success() {
        return Err("管理员授权被取消，TUN 需要安装一次提权内核".to_string());
    }
    if !dest.is_file() {
        return Err("提权内核安装后不存在，请重试".to_string());
    }
    Ok(dest)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperInfo {
    pub installed: bool,
    pub version: Option<String>,
    pub needs_update: bool,
    pub path: String,
}

fn helper_version() -> Option<String> {
    std::fs::read_to_string(system_bin_dir().join(".version"))
        .ok()
        .map(|s| s.trim().to_string())
}

fn user_kernel_version() -> Option<String> {
    data_dir()
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join("bin/.version")).ok())
        .map(|s| s.trim().to_string())
}

#[cfg(target_os = "linux")]
fn helper_info() -> HelperInfo {
    let path = data_dir().unwrap_or_default().join("bin/mihomo");
    HelperInfo {
        installed: crate::linux::network_authorized(&path),
        version: user_kernel_version(),
        needs_update: false,
        path: path.display().to_string(),
    }
}

#[cfg(not(target_os = "linux"))]
fn helper_info() -> HelperInfo {
    let installed = system_bin().is_file();
    let version = helper_version();
    let user = user_kernel_version();
    HelperInfo {
        installed,
        needs_update: installed && user.is_some() && version != user,
        version,
        path: system_bin().display().to_string(),
    }
}

#[tauri::command]
pub fn system_helper_info() -> Result<HelperInfo, String> {
    Ok(helper_info())
}

#[tauri::command]
pub async fn install_system_helper(app: AppHandle) -> Result<HelperInfo, String> {
    let (user_bin, version) = ensure_kernel(&app)?;
    // Explicit management actions must reinstall even when the version matches.
    install_system_kernel(&user_bin, &version, true)?;
    Ok(helper_info())
}

#[tauri::command]
pub fn uninstall_system_helper() -> Result<HelperInfo, String> {
    let info = helper_info();
    if !info.installed {
        return Ok(info);
    }
    #[cfg(target_os = "linux")]
    { crate::linux::authorize_kernel(Path::new(&info.path), true)?; }
    #[cfg(target_os = "macos")]
    {
        let dir = system_bin_dir();
        let script = format!("rm -rf '{}'", dir.display());
        let inner = script.replace('\\', "\\\\").replace('"', "\\\"");
        let osa = format!(
            "do shell script \"{}\" with administrator privileges",
            inner
        );
        let status = crate::platform::command("osascript")
            .arg("-e")
            .arg(&osa)
            .status()
            .map_err(|e| format!("调用系统授权失败：{e}"))?;
        if !status.success() {
            return Err("管理员授权被取消".to_string());
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        return Err("当前平台暂未实现提权内核卸载".to_string());
    }
    Ok(helper_info())
}

/// 读取内核日志尾部（日志页轮询）。
pub fn read_log_tail(lines: usize) -> Result<String, String> {
    let path = log_path()?;
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let all: Vec<&str> = text.lines().collect();
    let start = all.len().saturating_sub(lines);
    Ok(all[start..].join("\n"))
}

/// 重新释放内置内核与 Geo 数据（用户可在设置里手动触发）。
#[tauri::command]
pub fn reinstall_bundled_resources(app: tauri::AppHandle) -> Result<String, String> {
    let (_, version) = ensure_kernel_impl(&app, true)?;
    Ok(version)
}

#[derive(Serialize)]
pub struct KernelVersionInfo {
    pub name: String,
    pub version: String,
    pub path: String,
    pub builtin: bool,
    pub size: u64,
}

#[derive(Serialize)]
pub struct ResourceFileInfo {
    pub name: String,
    pub size: u64,
    pub exists: bool,
}

/// 本地可用的内核版本：内置版本 + kernels/ 下已下载的版本。
#[tauri::command]
pub async fn list_kernel_versions(app: AppHandle) -> Result<Vec<KernelVersionInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || local_kernel_versions(app))
        .await.map_err(|e| format!("读取内核版本失败：{e}"))?
}

fn local_kernel_versions(app: AppHandle) -> Result<Vec<KernelVersionInfo>, String> {
    let dir = data_dir()?;
    let kernels = dir.join("kernels");
    let mut out = Vec::new();

    if let Ok((bin, version)) = ensure_kernel(&app) {
        let size = std::fs::metadata(&bin).map(|m| m.len()).unwrap_or(0);
        out.push(KernelVersionInfo {
            name: "内置内核".to_string(),
            version,
            path: bin.display().to_string(),
            builtin: true,
            size,
        });
    }

    if let Ok(entries) = std::fs::read_dir(&kernels) {
        let target = Target::current()?;
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with('.')
                || !kernel_asset::is_verified_version(&entry.path(), target)
            {
                continue;
            }
            let path = entry.path().join(target.binary_name());
            let version = entry
                .file_name()
                .to_string_lossy()
                .trim_start_matches('v')
                .to_string();
            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            out.push(KernelVersionInfo {
                name: if version.starts_with("alpha-") { version.clone() } else { format!("v{version}") },
                version,
                path: path.display().to_string(),
                builtin: false,
                size,
            });
        }
    }

    out.sort_by(|a, b| {
        b.builtin
            .cmp(&a.builtin)
            .then_with(|| kernel_catalog::version_key(&b.version).cmp(&kernel_catalog::version_key(&a.version)))
    });
    Ok(out)
}

#[tauri::command]
pub fn list_resource_files() -> Result<Vec<ResourceFileInfo>, String> {
    let dir = data_dir()?;
    Ok(GEO_FILES
        .iter()
        .map(|(name, _)| {
            let path = dir.join(name);
            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            ResourceFileInfo {
                name: (*name).to_string(),
                size,
                exists: path.is_file(),
            }
        })
        .collect())
}

fn download_client(proxy_url: Option<&str>, timeout: u64) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(timeout))
        .user_agent("PPClash/0.2");
    if let Some(proxy) = proxy_url.filter(|p| !p.trim().is_empty()) {
        builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|e| format!("代理配置失败：{e}"))?);
    }
    builder.build().map_err(|e| format!("创建下载客户端失败：{e}"))
}

async fn github_json<T: serde::de::DeserializeOwned>(client: &reqwest::Client, url: &str) -> Result<T, String> {
    let mut response = client.get(url).send().await.map_err(|e| format!("读取官方版本失败：{e}"))?
        .error_for_status().map_err(|e| format!("GitHub API 请求失败：{e}"))?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > 8 * 1024 * 1024 { return Err("版本列表超过大小上限".into()); }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|e| format!("解析官方版本失败：{e}"))
}

#[tauri::command]
pub async fn list_kernel_releases(proxy_url: Option<String>, page: Option<u32>) -> Result<Vec<KernelReleaseInfo>, String> {
    let client = download_client(proxy_url.as_deref(), 30)?;
    let endpoint = kernel_catalog::catalog_endpoint(page.unwrap_or(1))?;
    let releases: Vec<kernel_catalog::Release> = github_json(&client, &endpoint).await?;
    Ok(kernel_catalog::catalog(releases, Target::current()?))
}

/// 下载当前平台最新稳定版 mihomo 到 kernels/<tag>/，返回版本信息。
/// `proxy_url` 用于 API/下载请求（自动代理时由前端给本机混合端口）；
/// `mirror_prefix` 用于给资产下载链接加 GitHub 镜像前缀。
#[tauri::command]
pub async fn download_kernel_version(
    proxy_url: Option<String>,
    mirror_prefix: Option<String>,
    version: Option<String>,
) -> Result<KernelVersionInfo, String> {
    let _files_guard = KERNEL_FILES_LOCK.try_lock().map_err(|_| "内核文件正在处理，请稍候".to_string())?;
    let endpoint = kernel_catalog::release_endpoint(version.as_deref())?;
    let client = download_client(proxy_url.as_deref(), 300)?;
    let release: kernel_catalog::Release = github_json(&client, &endpoint).await?;
    kernel_catalog::release_endpoint(Some(&release.tag_name))?;
    if release.draft || (release.prerelease && version.as_deref() != Some(kernel_asset::PREVIEW_TAG)) || version.as_ref().is_some_and(|tag| tag != &release.tag_name) {
        return Err("官方版本响应与所选通道不一致".into());
    }

    let target = Target::current()?;
    let asset = kernel_asset::select_asset(&release.assets, &release.tag_name, target)?;
    // 摘要只能来自上方固定官方 API；镜像只接收资产字节请求。
    kernel_asset::trusted_digest(asset, &release.tag_name)?;

    let mut url = asset.browser_download_url.clone();
    if let Some(mirror) = mirror_prefix.as_deref().filter(|m| !m.trim().is_empty()) {
        url = format!("{}/{}", mirror.trim_end_matches('/'), url);
    }
    let mut response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("下载失败：{e}"))?
        .error_for_status()
        .map_err(|e| format!("下载失败：{e}"))?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("读取下载内容失败：{e}"))?
    {
        if (bytes.len() + chunk.len()) as u64 > kernel_asset::MAX_BINARY_BYTES {
            return Err("下载内核超过大小上限".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let root = data_dir()?.join("kernels");
    let version = kernel_asset::cache_tag(&release.tag_name, asset, target)?.trim_start_matches('v').to_string();
    let asset = asset.clone();
    let tag = release.tag_name.clone();
    let bin = tauri::async_runtime::spawn_blocking(move || kernel_asset::install_verified(&root, &tag, &asset, &bytes, target))
        .await.map_err(|e| format!("安装内核失败：{e}"))??;
    let size = std::fs::metadata(&bin).map(|m| m.len()).unwrap_or(0);
    Ok(KernelVersionInfo {
        name: release.tag_name.clone(),
        version,
        path: bin.display().to_string(),
        builtin: false,
        size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_binary() -> Vec<u8> {
        let mut bytes = vec![0; 256];
        #[cfg(target_os = "macos")]
        {
            bytes[..4].copy_from_slice(&0xfeedfacfu32.to_le_bytes());
            let cpu = if cfg!(target_arch = "aarch64") {
                0x0100000cu32
            } else {
                0x01000007
            };
            bytes[4..8].copy_from_slice(&cpu.to_le_bytes());
            bytes[12..16].copy_from_slice(&2u32.to_le_bytes());
        }
        #[cfg(target_os = "windows")]
        {
            bytes[..2].copy_from_slice(b"MZ");
            bytes[60..64].copy_from_slice(&64u32.to_le_bytes());
            bytes[64..68].copy_from_slice(b"PE\0\0");
            let machine = if cfg!(target_arch = "aarch64") {
                0xaa64u16
            } else {
                0x8664
            };
            bytes[68..70].copy_from_slice(&machine.to_le_bytes());
            bytes[84..86].copy_from_slice(&112u16.to_le_bytes());
            bytes[86..88].copy_from_slice(&2u16.to_le_bytes());
            bytes[88..90].copy_from_slice(&0x20bu16.to_le_bytes());
        }
        #[cfg(target_os = "linux")]
        {
            bytes[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
            bytes[16..18].copy_from_slice(&2u16.to_le_bytes());
            let machine = if cfg!(target_arch = "aarch64") { 183u16 } else { 62 };
            bytes[18..20].copy_from_slice(&machine.to_le_bytes());
            bytes[20..24].copy_from_slice(&1u32.to_le_bytes());
            bytes[52..54].copy_from_slice(&64u16.to_le_bytes());
        }
        bytes
    }

    fn fixture_bundle(path: &Path, extra: Option<&str>) {
        use std::io::Write;
        let mut archive = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        archive
            .start_file(
                format!("bin/{}", crate::platform::kernel_binary_name()),
                options,
            )
            .unwrap();
        archive.write_all(&fixture_binary()).unwrap();
        archive.start_file("version.txt", options).unwrap();
        archive.write_all(b"v1.2.3").unwrap();
        for (name, size) in GEO_FILES {
            archive.start_file(name, options).unwrap();
            archive.write_all(&vec![0; size as usize]).unwrap();
        }
        if let Some(name) = extra {
            archive.start_file(name, options).unwrap();
            archive
                .write_all(b"wrong-platform overwritten binary")
                .unwrap();
        }
        archive.finish().unwrap();
    }

    #[test]
    fn bundle_aliases_and_unexpected_members_are_rejected_without_writes() {
        for name in [
            format!("bin/./{}", crate::platform::kernel_binary_name()),
            format!(
                "BIN/{}",
                crate::platform::kernel_binary_name().to_uppercase()
            ),
            format!("bin//{}", crate::platform::kernel_binary_name()),
            "unrelated.txt".into(),
        ] {
            let root = tempfile::tempdir().unwrap();
            let bundle = root.path().join("alias.zip");
            fixture_bundle(&bundle, Some(&name));
            let dest = root.path().join("data");
            std::fs::create_dir_all(&dest).unwrap();
            std::fs::write(dest.join("keep"), b"previous data").unwrap();
            let result = extract(&bundle, &dest);
            assert!(result.is_err(), "unsafe member accepted: {name}");
            assert_eq!(std::fs::read(dest.join("keep")).unwrap(), b"previous data");
            assert_eq!(std::fs::read_dir(&dest).unwrap().count(), 1);
        }
    }

    #[test]
    fn bundle_extracts_only_verified_exact_members() {
        let root = tempfile::tempdir().unwrap();
        let bundle = root.path().join("good.zip");
        fixture_bundle(&bundle, None);
        let dest = root.path().join("data");
        extract(&bundle, &dest).unwrap();
        let binary =
            std::fs::read(dest.join("bin").join(crate::platform::kernel_binary_name())).unwrap();
        assert_eq!(binary, fixture_binary());
        kernel_asset::validate_binary(&binary, Target::current().unwrap()).unwrap();
        assert!(geo_ok(&dest));
        assert_eq!(
            std::fs::read_to_string(dest.join("version.txt")).unwrap(),
            "v1.2.3"
        );
    }

    #[test]
    fn bundle_rejects_exact_duplicates_hidden_by_zip_library() {
        let root = tempfile::tempdir().unwrap();
        let bundle = root.path().join("duplicate.zip");
        fixture_bundle(&bundle, None);
        let mut bytes = std::fs::read(&bundle).unwrap();
        let end = bytes.len() - 22;
        assert_eq!(&bytes[end..end + 4], b"PK\x05\x06");
        let central = u32::from_le_bytes(bytes[end + 16..end + 20].try_into().unwrap()) as usize;
        let length = 46
            + [28, 30, 32]
                .iter()
                .map(|offset| {
                    u16::from_le_bytes(
                        bytes[central + offset..central + offset + 2]
                            .try_into()
                            .unwrap(),
                    ) as usize
                })
                .sum::<usize>();
        let duplicate = bytes[central..central + length].to_vec();
        let mut footer = bytes[end..].to_vec();
        for offset in [8, 10] {
            let count = u16::from_le_bytes(footer[offset..offset + 2].try_into().unwrap()) + 1;
            footer[offset..offset + 2].copy_from_slice(&count.to_le_bytes());
        }
        let size = u32::from_le_bytes(footer[12..16].try_into().unwrap()) + length as u32;
        footer[12..16].copy_from_slice(&size.to_le_bytes());
        bytes.truncate(end);
        bytes.extend(duplicate);
        bytes.extend(footer);
        std::fs::write(&bundle, bytes).unwrap();
        let dest = root.path().join("data");
        assert!(
            extract(&bundle, &dest).is_err(),
            "duplicate central directory entry must be rejected"
        );
        assert!(!dest.exists());
    }

    #[test]
    fn bundled_wrong_platform_is_rejected_before_extracting() {
        use std::io::Write;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let bundle = root.join("wrong.zip");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&bundle).unwrap());
        zip.start_file("bin/mihomo", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"MZ-this-is-not-a-Mach-O-kernel").unwrap();
        zip.start_file("version.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"v1.2.3").unwrap();
        zip.finish().unwrap();
        let dest = root.join("data");
        let result = extract(&bundle, &dest);
        let wrote_binary = dest.join("bin/mihomo").exists();
        assert!(result.is_err(), "wrong-platform bundle must be rejected");
        assert!(!wrote_binary, "validation must happen before extraction");
    }

    #[tokio::test]
    #[ignore]
    async fn download_latest_kernel_smoke() {
        let version = download_kernel_version(None, None, None)
            .await
            .expect("download latest kernel");
        assert!(Path::new(&version.path).is_file());
        assert!(!version.version.is_empty());
        let out = crate::platform::command(&version.path)
            .arg("-v")
            .output()
            .expect("run downloaded kernel");
        assert!(out.status.success());
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(text.contains(&version.version));
    }
}

const GEO_ONLINE: [(&str, &str); 5] = [
    (
        "geosite.dat",
        "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat",
    ),
    (
        "geoip.dat",
        "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.dat",
    ),
    (
        "geoip.metadb",
        "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.metadb",
    ),
    (
        "country.mmdb",
        "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/country.mmdb",
    ),
    (
        "ASN.mmdb",
        "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/GeoLite2-ASN.mmdb",
    ),
];

/// 直接从内置 MetaCubeX 在线源下载 Geo 数据，不走内核。
#[tauri::command]
pub async fn download_geo_resource(
    name: String,
    url: String,
    proxy_url: Option<String>,
    mirror_prefix: Option<String>,
) -> Result<u64, String> {
    let allowed = GEO_ONLINE
        .iter()
        .find(|(file, _)| *file == name)
        .ok_or_else(|| format!("不支持的 Geo 文件：{name}"))?;
    let _ = allowed;
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Geo 下载地址必须是 http(s) 链接".to_string());
    }
    let mut url = url;
    if let Some(mirror) = mirror_prefix.as_deref().filter(|m| !m.trim().is_empty()) {
        url = format!("{}/{}", mirror.trim_end_matches('/'), url);
    }
    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .user_agent("PPClash/0.1 geo");
    if let Some(proxy) = proxy_url.as_deref().filter(|p| !p.trim().is_empty()) {
        builder =
            builder.proxy(reqwest::Proxy::all(proxy).map_err(|e| format!("代理配置失败：{e}"))?);
    }
    let client = builder
        .build()
        .map_err(|e| format!("创建下载客户端失败：{e}"))?;
    let bytes = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("下载 {name} 失败：{e}"))?
        .error_for_status()
        .map_err(|e| format!("下载 {name} 失败：{e}"))?
        .bytes()
        .await
        .map_err(|e| format!("读取 {name} 失败：{e}"))?;
    if bytes.len() < 100_000 {
        return Err(format!("{name} 下载内容异常（文件过小）"));
    }
    let dir = data_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败：{e}"))?;
    let dest = dir.join(&name);
    let tmp = dir.join(format!(".{name}.download"));
    std::fs::write(&tmp, &bytes).map_err(|e| format!("写入 {name} 失败：{e}"))?;
    std::fs::rename(&tmp, &dest).map_err(|e| format!("替换 {name} 失败：{e}"))?;
    Ok(bytes.len() as u64)
}
