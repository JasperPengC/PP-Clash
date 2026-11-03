//! 内置内核与 Geo 数据的自管理。
//!
//! PP Clash 不再借用其它客户端的内核：`src-tauri/resources/kernel.zip` 里带着
//! mihomo + GeoIP/GeoSite，首次启动解压到应用数据目录；TUN 需要 root 时，
//! 再把用户目录里的内核安装一份到 `/Library/Application Support/PPClash/bin`
//! （setuid root，只装一次，之后 TUN 启停不再弹密码）。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

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

fn extract(zip: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| format!("创建数据目录失败：{e}"))?;
    let file = std::fs::File::open(zip).map_err(|e| format!("打开内置资源失败：{e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("读取内置资源失败：{e}"))?;
    archive
        .extract(dest)
        .map_err(|e| format!("解压内置内核失败：{e}"))?;
    Ok(())
}

/// 确保用户目录里有可用的内核 + Geo 数据，返回 (内核路径, 版本号)。
pub fn ensure_kernel(app: &AppHandle) -> Result<(PathBuf, String), String> {
    let dir = data_dir()?;
    let bin = dir.join("bin").join(crate::platform::kernel_binary_name());
    let version_file = dir.join("bin/.version");

    let zip = zip_path(app).ok_or_else(|| {
        "缺少内置内核资源 kernel.zip：请先运行 scripts/prepare-resources.sh 生成并重新构建"
            .to_string()
    })?;
    let want = zip_entry(&zip, "version.txt").unwrap_or_else(|| "unknown".to_string());
    let have = std::fs::read_to_string(&version_file)
        .ok()
        .map(|s| s.trim().to_string());

    let up_to_date = bin.is_file() && have.as_deref() == Some(want.as_str()) && geo_ok(&dir);
    if !up_to_date {
        // 旧版本可能留下 root 属主或残缺的数据文件；目录可写，先删再解压
        for (name, _) in GEO_FILES {
            let path = dir.join(name);
            if std::fs::metadata(&path).is_ok() {
                let _ = std::fs::remove_file(&path);
            }
        }
        let _ = std::fs::remove_file(&bin);
        extract(&zip, &dir)?;
        std::fs::create_dir_all(dir.join("bin")).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755));
        }
        std::fs::write(&version_file, &want).map_err(|e| format!("写入内核版本失败：{e}"))?;
    }

    Ok((bin, want))
}

/// 安装/更新一份 setuid root 的系统内核，供 TUN 使用。
///
/// 只在 TUN 第一次启动或内核版本变化时调用，需要管理员授权一次。
pub fn ensure_system_kernel(user_bin: &Path, version: &str) -> Result<PathBuf, String> {
    let dir = system_bin_dir();
    let dest = system_bin();
    let version_file = dir.join(".version");
    let have = std::fs::read_to_string(&version_file)
        .ok()
        .map(|s| s.trim().to_string());

    if dest.is_file() && have.as_deref() == Some(version) {
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

    let status = Command::new("osascript")
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
    ensure_system_kernel(&user_bin, &version)?;
    Ok(helper_info())
}

#[tauri::command]
pub fn uninstall_system_helper() -> Result<HelperInfo, String> {
    if !system_bin().is_file() {
        return Ok(helper_info());
    }
    #[cfg(target_os = "macos")]
    {
        let dir = system_bin_dir();
        let script = format!("rm -rf '{}'", dir.display());
        let inner = script.replace('\\', "\\\\").replace('"', "\\\"");
        let osa = format!("do shell script \"{}\" with administrator privileges", inner);
        let status = Command::new("osascript")
            .arg("-e")
            .arg(&osa)
            .status()
            .map_err(|e| format!("调用系统授权失败：{e}"))?;
        if !status.success() {
            return Err("管理员授权被取消".to_string());
        }
    }
    #[cfg(not(target_os = "macos"))]
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
    let dir = data_dir()?;
    let _ = std::fs::remove_file(dir.join("bin/.version"));
    let _ = std::fs::remove_file(dir.join("bin/mihomo"));
    for (name, _) in GEO_FILES {
        let _ = std::fs::remove_file(dir.join(name));
    }
    let (_, version) = ensure_kernel(&app)?;
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
pub fn list_kernel_versions(app: AppHandle) -> Result<Vec<KernelVersionInfo>, String> {
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
        for entry in entries.flatten() {
            let path = entry.path().join("mihomo");
            if !path.is_file() {
                continue;
            }
            let version = entry
                .file_name()
                .to_string_lossy()
                .trim_start_matches('v')
                .to_string();
            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            out.push(KernelVersionInfo {
                name: format!("v{version}"),
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
            .then_with(|| b.version.cmp(&a.version))
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

#[derive(serde::Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
}

#[derive(serde::Deserialize)]
struct GhRelease {
    tag_name: String,
    assets: Vec<GhAsset>,
}

/// 下载当前平台最新稳定版 mihomo 到 kernels/<tag>/，返回版本信息。
/// `proxy_url` 用于 API/下载请求（自动代理时由前端给本机混合端口）；
/// `mirror_prefix` 用于给资产下载链接加 GitHub 镜像前缀。
#[tauri::command]
pub async fn download_kernel_version(
    proxy_url: Option<String>,
    mirror_prefix: Option<String>,
) -> Result<KernelVersionInfo, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .user_agent("PPClash/0.1");
    if let Some(proxy) = proxy_url.as_deref().filter(|p| !p.trim().is_empty()) {
        builder = builder
            .proxy(reqwest::Proxy::all(proxy).map_err(|e| format!("代理配置失败：{e}"))?);
    }
    let client = builder
        .build()
        .map_err(|e| format!("创建下载客户端失败：{e}"))?;

    let resp = client
        .get("https://api.github.com/repos/MetaCubeX/mihomo/releases/latest")
        .send()
        .await
        .map_err(|e| format!("获取版本列表失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GitHub API 返回 HTTP {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let release: GhRelease =
        serde_json::from_str(&text).map_err(|e| format!("解析版本信息失败：{e}"))?;

    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        _ => "amd64",
    };
    let prefix = format!("mihomo-darwin-{arch}-");
    let exact_name = format!("{prefix}{}.gz", release.tag_name);
    let asset = release
        .assets
        .iter()
        .find(|a| a.name == exact_name)
        .or_else(|| {
            release.assets.iter().find(|a| {
                a.name.starts_with(&prefix)
                    && a.name.ends_with(".gz")
                    && !a.name.contains("compatible")
                    && !a.name.contains("-go")
            })
        })
        .or_else(|| {
            release
                .assets
                .iter()
                .find(|a| a.name.starts_with(&prefix) && a.name.ends_with(".gz"))
        })
        .ok_or_else(|| format!("没有找到 darwin-{arch} 的下载资产"))?;

    let mut url = asset.browser_download_url.clone();
    if let Some(mirror) = mirror_prefix.as_deref().filter(|m| !m.trim().is_empty()) {
        url = format!("{}/{}", mirror.trim_end_matches('/'), url);
    }
    let bytes = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("下载失败：{e}"))?
        .error_for_status()
        .map_err(|e| format!("下载失败：{e}"))?
        .bytes()
        .await
        .map_err(|e| format!("读取下载内容失败：{e}"))?;
    if bytes.len() < 1_000_000 {
        return Err("下载内容异常（文件过小）".to_string());
    }

    let version = release.tag_name.trim_start_matches('v').to_string();
    let dir = data_dir()?.join("kernels").join(&release.tag_name);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建版本目录失败：{e}"))?;
    let gz = dir.join("mihomo.gz");
    let bin = dir.join("mihomo");
    std::fs::write(&gz, &bytes).map_err(|e| format!("写入下载文件失败：{e}"))?;

    let out = std::fs::File::create(&bin).map_err(|e| format!("创建内核文件失败：{e}"))?;
    let status = Command::new("gunzip")
        .arg("-c")
        .arg(&gz)
        .stdout(Stdio::from(out))
        .status()
        .map_err(|e| format!("解压失败：{e}"))?;
    let _ = std::fs::remove_file(&gz);
    if !status.success() {
        let _ = std::fs::remove_file(&bin);
        return Err("解压内核失败".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755));
    }

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

    #[tokio::test]
    #[ignore]
    async fn download_latest_kernel_smoke() {
        let version = download_kernel_version(None, None)
            .await
            .expect("download latest kernel");
        assert!(Path::new(&version.path).is_file());
        assert!(!version.version.is_empty());
        let out = Command::new(&version.path)
            .arg("-v")
            .output()
            .expect("run downloaded kernel");
        assert!(out.status.success());
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(text.contains(&version.version));
    }
}
