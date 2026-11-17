use std::time::Duration;
use std::sync::OnceLock;

/// 控制器连接与系统代理独立；复用连接池，不为每次轮询重复创建客户端。
pub fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(2))
        .pool_max_idle_per_host(4)
        .build()
        .map_err(|e| format!("创建控制器客户端失败：{e}")))
        .as_ref().map_err(Clone::clone)
}

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
    let client = client()?;

    let url = format!("{}{}", base.trim_end_matches('/'), path);
    let m = reqwest::Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|_| format!("不支持的请求方法：{method}"))?;

    let mut req = client.request(m, &url).timeout(Duration::from_secs(8));
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    #[tokio::test]
    async fn reuses_controller_connection() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut requests = 0;
            let mut connections = 0;
            while requests < 2 {
                let (mut stream, _) = listener.accept().unwrap();
                connections += 1;
                stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 { break; }
                    loop {
                        line.clear();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" { break; }
                    }
                    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}").unwrap();
                    requests += 1;
                    if requests == 2 { break; }
                }
            }
            connections
        });
        assert_eq!(request(&base, "", "GET", "/one", None).await.unwrap(), "{}");
        assert_eq!(request(&base, "", "GET", "/two", None).await.unwrap(), "{}");
        assert_eq!(server.join().unwrap(), 1, "连续控制器请求应复用 TCP 连接");
    }
}
