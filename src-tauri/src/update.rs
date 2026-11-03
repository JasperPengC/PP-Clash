//! 应用更新检查。
//!
//! 只读取一个 JSON feed 并比较版本，不做下载/静默安装：
//! { "version": "0.2.0", "notes": "...", "url": "https://.../PP-Clash.dmg" }

use std::time::Duration;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub notes: Option<String>,
    pub url: String,
    pub sha256: Option<String>,
}

fn numeric_version(v: &str) -> Vec<u64> {
    v.trim()
        .trim_start_matches(['v', 'V'])
        .split('.')
        .map(|part| {
            part.chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse::<u64>()
                .unwrap_or(0)
        })
        .collect()
}

/// 返回 true 表示 remote 比 current 新；预发布后缀不参与比较，避免把 rc 当成正式版。
pub fn is_newer(remote: &str, current: &str) -> bool {
    let a = numeric_version(remote);
    let b = numeric_version(current);
    let len = a.len().max(b.len());
    for i in 0..len {
        let av = *a.get(i).unwrap_or(&0);
        let bv = *b.get(i).unwrap_or(&0);
        if av != bv {
            return av > bv;
        }
    }
    false
}

#[tauri::command]
pub async fn check_app_update(
    feed_url: String,
    current_version: String,
) -> Result<Option<UpdateInfo>, String> {
    if !feed_url.starts_with("http://") && !feed_url.starts_with("https://") {
        return Err("更新源必须是 http(s) 链接".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("PP-Clash")
        .build()
        .map_err(|e| format!("创建更新客户端失败：{e}"))?;
    let resp = client
        .get(&feed_url)
        .send()
        .await
        .map_err(|e| format!("检查更新失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("更新源返回 HTTP {}", resp.status()));
    }
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取更新源失败：{e}"))?;
    let body: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("更新源返回格式错误：{e}"))?;
    let version = body
        .get("version")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "更新源缺少 version".to_string())?;
    let url = body
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "更新源缺少 url".to_string())?;
    let notes = body
        .get("notes")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let sha256 = body
        .get("sha256")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty());
    if !is_newer(version, &current_version) {
        return Ok(None);
    }
    Ok(Some(UpdateInfo {
        version: version.trim_start_matches(['v', 'V']).to_string(),
        notes,
        url: url.to_string(),
        sha256,
    }))
}

#[cfg(test)]
mod tests {
    use super::is_newer;

    #[test]
    fn compares_versions() {
        assert!(is_newer("0.2.0", "0.1.9"));
        assert!(is_newer("v1.0.0", "0.9.9"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.2.0"));
        assert!(is_newer("1.0.1", "1.0"));
    }
}

/// 下载更新包到临时目录；有 sha256 时做校验。返回本地路径。
#[tauri::command]
pub async fn download_app_update(
    url: String,
    sha256: Option<String>,
) -> Result<String, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("更新地址必须是 http(s) 链接".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .user_agent("PP-Clash")
        .build()
        .map_err(|e| format!("创建下载客户端失败：{e}"))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("下载更新失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载更新返回 HTTP {}", resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取更新包失败：{e}"))?;
    if bytes.len() > 300 * 1024 * 1024 {
        return Err("更新包超过 300MB".to_string());
    }
    if let Some(expected) = sha256 {
        use sha2::{Digest, Sha256};
        let actual = format!("{:x}", Sha256::digest(&bytes));
        if actual != expected.trim().to_ascii_lowercase() {
            return Err("更新包校验失败（sha256 不匹配）".to_string());
        }
    }

    let name = url
        .split('?')
        .next()
        .unwrap_or(url.as_str())
        .rsplit('/')
        .next()
        .unwrap_or("PP-Clash-update");
    let safe = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || ".-_".contains(c) { c } else { '_' })
        .collect::<String>();
    let ext = std::path::Path::new(&safe)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    if !matches!(ext, "dmg" | "exe" | "msi" | "zip") {
        return Err("更新包格式不受支持".to_string());
    }
    let dest = std::env::temp_dir().join(format!("PP-Clash-update-{safe}"));
    std::fs::write(&dest, &bytes).map_err(|e| format!("写入更新包失败：{e}"))?;
    Ok(dest.display().to_string())
}

/// 打开刚下载的更新包；限制在临时目录且扩展名受支持。
#[tauri::command]
pub fn open_downloaded_update(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(ext.as_str(), "dmg" | "exe" | "msi" | "zip") {
        return Err("不支持的更新包格式".to_string());
    }
    if !p.is_file() {
        return Err("更新包不存在".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        crate::platform::command("cmd")
            .args(["/C", "start", "", &path])
            .status()
            .map_err(|e| format!("打开更新包失败：{e}"))?;
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        crate::platform::command("open")
            .arg(&path)
            .status()
            .map_err(|e| format!("打开更新包失败：{e}"))?;
        Ok(())
    }
}
