use std::time::Duration;

/// 转发一次 mihomo external-controller 请求。
///
/// 前端不直连 9090 的原因：统一处理 secret、超时和错误格式，
/// 也避免 WebView 对本地端口的各种限制。
/// 托盘（tray.rs）复用同一实现，保证前后端看到同一个内核状态。
pub async fn request(
    base: &str,
    secret: &str,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{e}"))?;

    let url = format!("{}{}", base.trim_end_matches('/'), path);
    let m = reqwest::Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|_| format!("不支持的请求方法：{method}"))?;

    let mut req = client.request(m, &url);
    if !secret.is_empty() {
        req = req.bearer_auth(secret);
    }
    if let Some(b) = body {
        req = req.header("Content-Type", "application/json").body(b.to_string());
    }

    let resp = req.send().await.map_err(|e| format!("请求内核失败：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("读取内核响应失败：{e}"))?;

    if !status.is_success() {
        return Err(format!("内核返回 {status}：{text}"));
    }

    Ok(text)
}

#[tauri::command]
pub async fn mihomo_request(
    base: String,
    secret: String,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<String, String> {
    request(&base, &secret, &method, path.as_str(), body.as_deref()).await
}
