use std::{io::Write, time::Duration};
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;
use super::Vpn;

#[derive(Default)]
pub struct UpdateDownload(Mutex<()>);

#[tauri::command]
pub async fn android_app_info(app: AppHandle) -> Result<serde_json::Value, String> {
    app.state::<Vpn>().0.run_mobile_plugin_async("appInfo", json!({})).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    app.state::<Vpn>().0.run_mobile_plugin_async::<serde_json::Value>("openExternal", json!({ "url": url }))
        .await.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn download_app_update(app: AppHandle, url: String, sha256: Option<String>) -> Result<String, String> {
    let expected = sha256.filter(|hash| hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or("发布包缺少有效的 SHA-256 校验值")?.to_ascii_lowercase();
    let parsed = reqwest::Url::parse(&url).map_err(|_| "更新地址无效")?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("github.com")
        || !parsed.path().contains("/releases/download/") || !parsed.path().ends_with(".apk") {
        return Err("仅支持 GitHub Releases 的 Android 安装包".into());
    }
    let state = app.state::<UpdateDownload>();
    let _guard = state.0.try_lock().map_err(|_| "更新包正在下载")?;
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("updates");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // 临时文件随失败自动删除；流式写入，不把整个 APK 留在内存。
    let mut file = tempfile::NamedTempFile::new_in(&dir).map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder().timeout(Duration::from_secs(300)).user_agent("PP-Clash")
        .build().map_err(|e| e.to_string())?;
    let mut response = client.get(parsed).send().await.map_err(|e| format!("下载失败：{e}"))?
        .error_for_status().map_err(|e| format!("下载失败：{e}"))?;
    const LIMIT: u64 = 300 * 1024 * 1024;
    if response.content_length().is_some_and(|size| size > LIMIT) { return Err("安装包超过 300 MB".into()); }
    let mut size = 0u64;
    let mut digest = Sha256::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("下载中断：{e}"))? {
        size += chunk.len() as u64;
        if size > LIMIT { return Err("安装包超过 300 MB".into()); }
        digest.update(&chunk);
        file.write_all(&chunk).map_err(|e| format!("写入失败：{e}"))?;
    }
    if size == 0 || format!("{:x}", digest.finalize()) != expected { return Err("安装包校验失败，请重新下载".into()); }
    let path = dir.join("update.apk");
    file.persist(&path).map_err(|e| format!("保存安装包失败：{e}"))?;
    Ok(path.display().to_string())
}

#[tauri::command]
pub async fn open_downloaded_update(app: AppHandle, path: String) -> Result<(), String> {
    app.state::<Vpn>().0.run_mobile_plugin_async::<serde_json::Value>("openUpdate", json!({ "path": path }))
        .await.map(|_| ()).map_err(|e| e.to_string())
}
