use std::time::Duration;

/// 解析数据目录：相对名落到 ~/Library/Application Support/ 下，绝对路径原样使用。
pub fn resolve_data_dir(data_dir: &str) -> Result<std::path::PathBuf, String> {
    let dir = std::path::PathBuf::from(data_dir);
    let dir = if dir.is_absolute() {
        dir
    } else {
        let home = std::env::var("HOME").map_err(|_| "读不到 HOME".to_string())?;
        std::path::PathBuf::from(home)
            .join("Library/Application Support")
            .join(data_dir)
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建工作目录失败：{e}"))?;
    Ok(dir)
}

/// 把应用状态（订阅、活动订阅、安全策略、设置）落盘到 state.json。
///
/// 用一份 JSON 而不是多文件，避免订阅与配置/设置之间出现不一致。
#[tauri::command]
pub fn save_app_state(content: String, data_dir: String) -> Result<(), String> {
    let dir = resolve_data_dir(&data_dir)?;
    let path = dir.join("state.json");
    std::fs::write(&path, content).map_err(|e| format!("写状态失败：{e}"))?;
    Ok(())
}

/// 读取 state.json。没有则返回 None（首次启动）。
#[tauri::command]
pub fn load_app_state(data_dir: String) -> Result<Option<String>, String> {
    let dir = resolve_data_dir(&data_dir)?;
    let path = dir.join("state.json");
    if !path.is_file() {
        return Ok(None);
    }
    let s = std::fs::read_to_string(&path).map_err(|e| format!("读状态失败：{e}"))?;
    Ok(Some(s))
}

/// 拉取订阅的结果：原文 + 订阅响应头里的元信息。
///
/// 机场通常用响应头下发三样东西，客户端如果能读出来，体验会好很多：
/// - `profile-title` / `Content-Disposition`：订阅的真实名字（常常是机场名）
/// - `subscription-userinfo`：已用 / 总量 / 到期时间，用于剩余流量进度条
/// - `profile-update-interval`：建议的自动更新间隔
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionPayload {
    pub raw: String,
    pub profile_title: Option<String>,
    pub content_disposition: Option<String>,
    pub subscription_userinfo: Option<String>,
    pub profile_update_interval: Option<String>,
}

fn header_value(headers: &reqwest::header::HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// 拉取订阅原文。
///
/// 为什么不在前端 fetch：机场订阅一般不返回 CORS 头，WebView 里会被拦。
/// 而且部分机场按 UA 返回不同格式，这里统一用 clash.meta 的 UA。
#[tauri::command]
pub async fn fetch_subscription(
    url: String,
    proxy_port: Option<u16>,
) -> Result<SubscriptionPayload, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("订阅地址必须是 http(s) 链接".to_string());
    }

    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("clash.meta");
    if let Some(port) = proxy_port {
        builder = builder.proxy(
            reqwest::Proxy::all(format!("http://127.0.0.1:{port}"))
                .map_err(|e| format!("内核代理配置失败：{e}"))?,
        );
    }
    let client = builder
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{e}"))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("订阅返回 HTTP {status}"));
    }

    // 元信息必须在读 body 之前从 headers 里取（读完之后 headers 还在，但这里更直观）
    let profile_title = header_value(resp.headers(), "profile-title");
    let content_disposition = header_value(resp.headers(), "content-disposition");
    let subscription_userinfo = header_value(resp.headers(), "subscription-userinfo");
    let profile_update_interval = header_value(resp.headers(), "profile-update-interval");

    let text = resp.text().await.map_err(|e| format!("读取响应失败：{e}"))?;

    // 部分机场会返回一段 HTML（比如到期提示页），提前拦住，别让下游 YAML 解析炸掉
    if text.trim_start().starts_with('<') {
        return Err("订阅返回的是网页而不是配置，可能已过期或链接失效".to_string());
    }

    Ok(SubscriptionPayload {
        raw: text,
        profile_title,
        content_disposition,
        subscription_userinfo,
        profile_update_interval,
    })
}

/// 把配置写到磁盘，返回路径。
///
/// `data_dir` 允许传相对名（如 "PPClash"），会落到 `~/Library/Application Support/` 下；
/// 传绝对路径则原样使用。
#[tauri::command]
pub fn save_config(content: String, data_dir: String) -> Result<String, String> {
    let dir = std::path::PathBuf::from(&data_dir);
    let dir = if dir.is_absolute() {
        dir
    } else {
        let home = std::env::var("HOME").map_err(|_| "读不到 HOME".to_string())?;
        std::path::PathBuf::from(home)
            .join("Library/Application Support")
            .join(dir)
    };

    std::fs::create_dir_all(&dir).map_err(|e| format!("创建工作目录失败：{e}"))?;
    let path = dir.join("config.yaml");
    std::fs::write(&path, content).map_err(|e| format!("写配置失败：{e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[derive(serde::Serialize)]
pub struct BackupEntry {
    pub name: String,
    pub size: u64,
    pub mtime_ms: u64,
}

fn backups_dir(data_dir: &str) -> Result<std::path::PathBuf, String> {
    let dir = resolve_data_dir(data_dir)?;
    let backups = dir.join("backups");
    std::fs::create_dir_all(&backups).map_err(|e| format!("创建备份目录失败：{e}"))?;
    Ok(backups)
}

/// 备份 state.json 到数据目录 backups/，返回备份文件路径。
#[tauri::command]
pub fn backup_app_state(data_dir: String) -> Result<String, String> {
    let dir = resolve_data_dir(&data_dir)?;
    let src = dir.join("state.json");
    if !src.is_file() {
        return Err("还没有可备份的状态文件".to_string());
    }
    let backups = backups_dir(&data_dir)?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dest = backups.join(format!("state-{ts}.json"));
    std::fs::copy(&src, &dest).map_err(|e| format!("备份失败：{e}"))?;
    Ok(dest.display().to_string())
}

/// 列出已有备份（新的在前）。
#[tauri::command]
pub fn list_backups(data_dir: String) -> Result<Vec<BackupEntry>, String> {
    let backups = backups_dir(&data_dir)?;
    let mut out = Vec::new();
    let entries = std::fs::read_dir(&backups).map_err(|e| format!("读取备份目录失败：{e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let meta = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(BackupEntry {
            name,
            size: meta.len(),
            mtime_ms,
        });
    }
    out.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    Ok(out)
}

/// 从备份恢复 state.json；前端需要重新加载页面（或重启应用）。
#[tauri::command]
pub fn restore_backup(data_dir: String, name: String) -> Result<(), String> {
    let dir = resolve_data_dir(&data_dir)?;
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("非法备份名".to_string());
    }
    let src = backups_dir(&data_dir)?.join(&name);
    if !src.is_file() {
        return Err("备份文件不存在".to_string());
    }
    std::fs::copy(&src, dir.join("state.json")).map_err(|e| format!("恢复失败：{e}"))?;
    Ok(())
}
