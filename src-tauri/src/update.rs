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
    if !is_newer(version, &current_version) {
        return Ok(None);
    }
    Ok(Some(UpdateInfo {
        version: version.trim_start_matches(['v', 'V']).to_string(),
        notes,
        url: url.to_string(),
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
