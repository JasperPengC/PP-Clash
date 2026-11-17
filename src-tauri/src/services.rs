//! 概览页服务连通性探测。
//!
//! 通过 mihomo 的 mixed 端口发请求：系统代理/TUN 模式下都能反映真实出口质量。

use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Manager;

use crate::kernel::KernelState;
use crate::mihomo;

#[derive(Debug, Serialize)]
pub struct ServiceProbe {
    pub id: String,
    pub ok: bool,
    pub latency_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct IpCountry {
    pub country: Option<String>,
    pub country_code: Option<String>,
}

/// 查询出口 IP 的国家/地区（经 mihomo 出口）。失败返回空结果，不影响概览。
#[tauri::command]
pub async fn lookup_ip_country_auto(app: tauri::AppHandle, ip: String) -> Result<IpCountry, String> {
    let flags = app.state::<crate::prefs::AppFlags>();
    let port = *flags.mixed_port.lock().unwrap();
    let tun = *flags.tun_enabled.lock().unwrap();
    lookup_ip_country(ip, if tun { 0 } else { port }).await
}

#[tauri::command]
pub async fn lookup_ip_country(ip: String, mixed_port: u16) -> Result<IpCountry, String> {
    // 只接受 IP 字符，避免把任意 URL 拼进请求。
    if ip.is_empty()
        || !ip
            .chars()
            .all(|c| c.is_ascii_hexdigit() || c == '.' || c == ':')
    {
        return Ok(IpCountry { country: None, country_code: None });
    }
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .user_agent("PPClash/1.0 geo lookup");
    builder = if mixed_port > 0 {
        builder.proxy(
            reqwest::Proxy::all(format!("http://127.0.0.1:{mixed_port}"))
                .map_err(|e| format!("代理配置失败：{e}"))?,
        )
    } else {
        builder.no_proxy()
    };
    let client = builder
        .build()
        .map_err(|e| format!("查询客户端创建失败：{e}"))?;
    // 多个轻量 GeoIP 源依次兜底；单个服务被限流/被墙时不至于整块地区信息消失。
    let providers = [
        format!("https://ipwho.is/{ip}"),
        format!("https://ipapi.co/{ip}/json/"),
        format!("https://api.ip.sb/geoip/{ip}"),
    ];
    for url in providers {
        let Ok(resp) = client.get(&url).send().await else { continue };
        if !resp.status().is_success() {
            continue;
        }
        let Ok(text) = resp.text().await else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let country = v
            .get("country")
            .or_else(|| v.get("country_name"))
            .and_then(|x| x.as_str())
            .map(str::to_string);
        let code = v
            .get("country_code")
            .and_then(|x| x.as_str())
            .map(str::to_string);
        if country.is_some() || code.is_some() {
            return Ok(IpCountry { country, country_code: code });
        }
    }
    Ok(IpCountry {
        country: None,
        country_code: None,
    })
}

const TARGETS: [(&str, &str); 5] = [
    ("google", "https://www.google.com/generate_204"),
    ("youtube", "https://www.youtube.com/generate_204"),
    ("github", GITHUB_SERVICE_URL),
    ("openai", "https://chatgpt.com/"),
    ("anthropic", "https://www.anthropic.com/"),
];

const GITHUB_SERVICE_URL: &str = "https://github.com/robots.txt";

fn service_delay_response(id: &str, status: u16, body: &str) -> ServiceProbe {
    let detail = if status == 503 || status == 504 {
        Some("节点到目标不可达或测速超时".to_string())
    } else if status != 200 {
        Some(format!("控制器返回 HTTP {status}"))
    } else {
        None
    };
    let delay = (status == 200)
        .then(|| serde_json::from_str::<serde_json::Value>(body).ok()?.get("delay")?.as_u64())
        .flatten();
    let ok = delay.is_some();
    ServiceProbe {
        id: id.to_string(),
        ok,
        latency_ms: delay,
        status: Some(if ok { "reachable" } else if status == 503 || status == 504 { "unreachable" } else { "error" }),
        detail: if ok { None } else { detail.or_else(|| Some("控制器响应格式异常".to_string())) },
    }
}

fn health_outcome(status: u16, body: &str) -> Option<bool> {
    // mihomo delay API：连接拒绝/重置等返回 503，超时返回 504。
    // 这是控制器的状态；目标站自身的 403/429/503 被 expected 接受后返回 200+delay。
    if status == 503 || status == 504 { return Some(false); }
    if status != 200 { return None; }
    serde_json::from_str::<serde_json::Value>(body).ok()?
        .get("delay")?.as_u64().map(|_| true)
}

/// 仅判断到站连接；403/429 等 HTTP 响应证明站点可达，不能引发自动换 IP。
#[tauri::command]
pub async fn probe_node_health(app: tauri::AppHandle, node: String) -> Result<std::collections::BTreeMap<String, Option<bool>>, String> {
    let state = app.state::<KernelState>();
    let port = *state.controller_port.lock().await;
    let secret = state.controller_secret.lock().await.clone();
    let client = mihomo::client()?;
    let probe = |id: &'static str, url: &'static str| {
        let endpoint = format!("http://127.0.0.1:{port}/proxies/{}/delay?url={}&timeout=5000&expected=200-599", pct_encode(&node), pct_encode(url));
        let secret = secret.clone();
        async move {
            let result = match client.get(endpoint).bearer_auth(secret).timeout(Duration::from_secs(7)).send().await {
                Ok(response) => {
                    let status = response.status().as_u16();
                    response.text().await.ok().and_then(|body| health_outcome(status, &body))
                },
                Err(_) => None,
            };
            (id.to_string(), result)
        }
    };
    let (google, github, openai) = tokio::join!(
        probe("google", "https://www.google.com/generate_204"),
        probe("github", "https://github.com/"),
        probe("openai", "https://chatgpt.com/")
    );
    Ok([google, github, openai].into_iter().collect())
}

#[cfg(test)]
mod health_tests {
    use super::*;
    #[test]
    fn only_confirmed_timeout_is_a_failure() {
        assert_eq!(health_outcome(200, r#"{"delay":0}"#), Some(true));
        assert_eq!(health_outcome(504, r#"{"message":"timeout"}"#), Some(false));
        assert_eq!(health_outcome(503, r#"{"message":"connection refused"}"#), Some(false));
        for status in [401, 403, 404, 429, 500] {
            assert_eq!(health_outcome(status, "{}"), None);
        }
        assert_eq!(health_outcome(200, "{}"), None);
    }

    #[test]
    fn service_probe_distinguishes_control_errors_from_network_failure() {
        let reachable = service_delay_response("github", 200, r#"{"delay":82}"#);
        assert!(reachable.ok);
        assert_eq!(reachable.latency_ms, Some(82));
        for code in [401, 403, 404, 429, 500] {
            let probe = service_delay_response("github", code, "{}");
            assert!(!probe.ok);
            assert_eq!(probe.status, Some("error"));
            assert!(probe.detail.is_some());
        }
        assert_eq!(service_delay_response("github", 200, "{}").status, Some("error"));
        assert_eq!(service_delay_response("github", 504, "{}").status, Some("unreachable"));
        assert_eq!(service_delay_response("github", 503, "{}").status, Some("unreachable"));
    }

    #[tokio::test]
    async fn github_service_uses_small_target_and_preserves_exact_node_name() {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let start = Instant::now();
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock && start.elapsed() < Duration::from_secs(3) => std::thread::sleep(Duration::from_millis(5)),
                    Err(e) => panic!("mock controller: {e}"),
                }
            };
            // macOS 接受的 socket 可能继承 listener 的 nonblocking，读请求前恢复阻塞模式。
            stream.set_nonblocking(false).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            loop {
                let mut line = String::new(); reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() { break; }
                request.push_str(&line);
            }
            let body = r#"{"delay":82}"#;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            request
        });
        let result = probe_github_at(&base, "test-secret", " A/B ").await;
        let request = server.join().unwrap();
        assert!(result.ok);
        assert!(request.starts_with("GET /proxies/%20A%2FB%20/delay?"));
        assert!(request.contains("url=https%3A%2F%2Fgithub.com%2Frobots.txt"));
        assert!(request.contains("expected=200 "));
        assert!(request.to_lowercase().contains("authorization: bearer test-secret"));
    }
}

async fn probe_single(proxy_port: Option<u16>, id: &str, url: &str) -> ServiceProbe {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .user_agent("PPClash/1.0 service probe");
    builder = match proxy_port {
        Some(port) => match reqwest::Proxy::all(format!("http://127.0.0.1:{port}")) {
            Ok(proxy) => builder.proxy(proxy),
            Err(_) => builder.no_proxy(),
        },
        None => builder.no_proxy(),
    };
    let started = Instant::now();
    let ok = match builder.build() {
        // HTTP 拒绝/限流也说明到站连接已建立。
        Ok(client) => client.get(url).send().await.is_ok(),
        Err(_) => false,
    };
    ServiceProbe {
        id: id.to_string(),
        ok,
        latency_ms: ok.then_some(started.elapsed().as_millis() as u64),
        status: Some(if ok { "reachable" } else { "unreachable" }),
        detail: (!ok).then(|| "无法连接目标站点".to_string()),
    }
}

fn pct_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        let ch = *byte as char;
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '~') {
            out.push(ch);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

async fn probe_github_at(base: &str, secret: &str, node: &str) -> ServiceProbe {
    let path = format!("/proxies/{}/delay?url={}&timeout=5000&expected=200", pct_encode(node), pct_encode(GITHUB_SERVICE_URL));
    let response = async {
        let response = mihomo::client()?.get(format!("{base}{path}"))
            .bearer_auth(secret).timeout(Duration::from_secs(7)).send().await
            .map_err(|_| "无法连接本地控制器，未验证 GitHub".to_string())?;
        let status = response.status().as_u16();
        let body = response.text().await.map_err(|_| "无法读取控制器响应".to_string())?;
        Ok::<_, String>((status, body))
    }.await;
    match response {
        Ok((status, body)) => service_delay_response("github", status, &body),
        Err(detail) => ServiceProbe { id: "github".to_string(), ok: false, latency_ms: None,
            status: Some("error"), detail: Some(detail) },
    }
}

/// 与分组测速使用同一节点、同一资源。服务连通只判断有无 HTTP 响应；
/// expected=200 保持内核历史与严格测速口径一致，不能用宽松 expected 污染其成功状态。
async fn probe_github_via_fixed_node(
    app: &tauri::AppHandle,
    node: &str,
) -> ServiceProbe {
    let state = app.state::<KernelState>();
    let port = *state.controller_port.lock().await;
    let secret = app.state::<crate::prefs::AppFlags>().controller_secret.lock().unwrap().clone();
    probe_github_at(&format!("http://127.0.0.1:{port}"), &secret, node).await
}

/// 单个服务探测：前端并发调用，谁先完成谁先渲染。
#[tauri::command]
pub async fn probe_service_auto(
    app: tauri::AppHandle,
    id: String,
    egress_node: Option<String>,
) -> Result<ServiceProbe, String> {
    let Some((target_id, url)) = TARGETS.iter().find(|(key, _)| *key == id) else {
        return Err("未知服务".to_string());
    };
    // GitHub 固定出口已配置时，服务连通也必须测那个节点。
    if *target_id == "github" {
        if let Some(node) = egress_node.as_deref().filter(|n| !n.trim().is_empty()) {
            return Ok(probe_github_via_fixed_node(&app, node).await);
        }
    }
    let flags = app.state::<crate::prefs::AppFlags>();
    let port = *flags.mixed_port.lock().unwrap();
    let tun = *flags.tun_enabled.lock().unwrap();

    if tun {
        let direct = probe_single(None, target_id, url).await;
        if direct.ok {
            return Ok(direct);
        }
    }
    Ok(probe_single((port > 0).then_some(port), target_id, url).await)
}

#[tauri::command]
pub async fn probe_services_auto(app: tauri::AppHandle) -> Result<Vec<ServiceProbe>, String> {
    let flags = app.state::<crate::prefs::AppFlags>();
    let port = *flags.mixed_port.lock().unwrap();
    let tun = *flags.tun_enabled.lock().unwrap();
    // TUN 下直连请求已经被内核接管，优先直连；否则走 mixed 代理。
    let direct = probe_with(None).await;
    if tun && direct.as_ref().map(|v| v.iter().any(|x| x.ok)).unwrap_or(false) {
        return direct;
    }
    probe_with(Some(port)).await
}

#[tauri::command]
pub async fn probe_services(mixed_port: u16) -> Result<Vec<ServiceProbe>, String> {
    probe_with((mixed_port > 0).then_some(mixed_port)).await
}

async fn probe_with(proxy_port: Option<u16>) -> Result<Vec<ServiceProbe>, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .user_agent("PPClash/1.0 service probe");
    builder = match proxy_port {
        Some(port) => builder.proxy(
            reqwest::Proxy::all(format!("http://127.0.0.1:{port}"))
                .map_err(|e| format!("代理配置失败：{e}"))?,
        ),
        None => builder.no_proxy(),
    };
    let client = builder
        .build()
        .map_err(|e| format!("探测客户端创建失败：{e}"))?;

    async fn one(client: &reqwest::Client, url: &str) -> (bool, Option<u64>) {
        let started = Instant::now();
        let result = client.get(url).send().await;
        let latency_ms = started.elapsed().as_millis() as u64;
        let ok = matches!(result, Ok(resp) if resp.status().is_success() || resp.status().is_redirection());
        (ok, ok.then_some(latency_ms))
    }

    let (a, b, c, d, e) = tokio::join!(
        one(&client, TARGETS[0].1),
        one(&client, TARGETS[1].1),
        one(&client, TARGETS[2].1),
        one(&client, TARGETS[3].1),
        one(&client, TARGETS[4].1),
    );
    Ok(vec![
        ServiceProbe { id: TARGETS[0].0.to_string(), ok: a.0, latency_ms: a.1, status: Some(if a.0 { "reachable" } else { "unreachable" }), detail: (!a.0).then(|| "无法连接目标站点".to_string()) },
        ServiceProbe { id: TARGETS[1].0.to_string(), ok: b.0, latency_ms: b.1, status: Some(if b.0 { "reachable" } else { "unreachable" }), detail: (!b.0).then(|| "无法连接目标站点".to_string()) },
        ServiceProbe { id: TARGETS[2].0.to_string(), ok: c.0, latency_ms: c.1, status: Some(if c.0 { "reachable" } else { "unreachable" }), detail: (!c.0).then(|| "无法连接目标站点".to_string()) },
        ServiceProbe { id: TARGETS[3].0.to_string(), ok: d.0, latency_ms: d.1, status: Some(if d.0 { "reachable" } else { "unreachable" }), detail: (!d.0).then(|| "无法连接目标站点".to_string()) },
        ServiceProbe { id: TARGETS[4].0.to_string(), ok: e.0, latency_ms: e.1, status: Some(if e.0 { "reachable" } else { "unreachable" }), detail: (!e.0).then(|| "无法连接目标站点".to_string()) },
    ])
}


#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpQuality {
    pub ip: String,
    pub country: Option<String>,
    pub region: Option<String>,
    pub city: Option<String>,
    pub isp: Option<String>,
    pub org: Option<String>,
    pub asn: Option<String>,
    pub hosting: bool,
    pub proxy: bool,
    pub mobile: bool,
    pub kind: String,
    pub risk: String,
    pub score: u8,
}

/// 出口 IP 质量：IP 类型 / 代理标记 / 机房标记 / ASN / 地区。
///
/// 只使用公开的 IP 元数据，不做密钥依赖的服务；风险等级是按 hosting/proxy/mobile
/// 标记派生，不冒充黑名单或欺诈分。
#[tauri::command]
pub async fn check_ip_quality_auto(
    app: tauri::AppHandle,
    ip: String,
) -> Result<IpQuality, String> {
    let flags = app.state::<crate::prefs::AppFlags>();
    let port = *flags.mixed_port.lock().unwrap();
    let tun = *flags.tun_enabled.lock().unwrap();
    lookup_ip_quality(ip, if tun { 0 } else { port }).await
}

pub async fn lookup_ip_quality(ip: String, mixed_port: u16) -> Result<IpQuality, String> {
    if ip.is_empty()
        || !ip
            .chars()
            .all(|c| c.is_ascii_hexdigit() || c == '.' || c == ':')
    {
        return Err("IP 地址格式不正确".to_string());
    }
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
        .user_agent("PPClash/1.0 ip quality");
    builder = if mixed_port > 0 {
        builder.proxy(
            reqwest::Proxy::all(format!("http://127.0.0.1:{mixed_port}"))
                .map_err(|e| format!("代理配置失败：{e}"))?,
        )
    } else {
        builder.no_proxy()
    };
    let client = builder
        .build()
        .map_err(|e| format!("创建 IP 查询客户端失败：{e}"))?;
    let url = format!(
        "http://ip-api.com/json/{ip}?fields=status,country,regionName,city,isp,org,as,asname,proxy,hosting,mobile,query"
    );
    let mut out = IpQuality {
        ip: ip.clone(),
        country: None,
        region: None,
        city: None,
        isp: None,
        org: None,
        asn: None,
        hosting: false,
        proxy: false,
        mobile: false,
        kind: "未知".to_string(),
        risk: "未知".to_string(),
        score: 0,
    };
    if let Ok(resp) = client.get(&url).send().await {
        if let Ok(text) = resp.text().await {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if v.get("status").and_then(|x| x.as_str()) == Some("success") {
                    out.country = v.get("country").and_then(|x| x.as_str()).map(str::to_string);
                    out.region = v.get("regionName").and_then(|x| x.as_str()).map(str::to_string);
                    out.city = v.get("city").and_then(|x| x.as_str()).map(str::to_string);
                    out.isp = v.get("isp").and_then(|x| x.as_str()).map(str::to_string);
                    out.org = v.get("org").and_then(|x| x.as_str()).map(str::to_string);
                    out.asn = v
                        .get("as")
                        .or_else(|| v.get("asname"))
                        .and_then(|x| x.as_str())
                        .map(str::to_string);
                    out.hosting = v.get("hosting").and_then(|x| x.as_bool()).unwrap_or(false);
                    out.proxy = v.get("proxy").and_then(|x| x.as_bool()).unwrap_or(false);
                    out.mobile = v.get("mobile").and_then(|x| x.as_bool()).unwrap_or(false);
                }
            }
        }
    }
    if out.country.is_none() {
        // ip-api 失败时用 ipwho.is 补基础归属；没有 proxy/hosting 标记，风险保持未知。
        if let Ok(resp) = client
            .get(format!("https://ipwho.is/{ip}"))
            .send()
            .await
        {
            if let Ok(text) = resp.text().await {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                    out.country = v.get("country").and_then(|x| x.as_str()).map(str::to_string);
                    out.region = v.get("region").and_then(|x| x.as_str()).map(str::to_string);
                    out.city = v.get("city").and_then(|x| x.as_str()).map(str::to_string);
                    out.asn = v
                        .get("connection")
                        .and_then(|c| c.get("asn"))
                        .map(|x| format!("AS{}", x.as_u64().unwrap_or(0)));
                    out.org = v
                        .get("connection")
                        .and_then(|c| c.get("org"))
                        .and_then(|x| x.as_str())
                        .map(str::to_string);
                    out.isp = v
                        .get("connection")
                        .and_then(|c| c.get("isp"))
                        .and_then(|x| x.as_str())
                        .map(str::to_string);
                }
            }
        }
    }
    out.kind = if out.proxy {
        "代理出口".to_string()
    } else if out.hosting {
        "机房 IP".to_string()
    } else if out.mobile {
        "移动网络".to_string()
    } else if out.country.is_some() {
        "住宅网络".to_string()
    } else {
        "未知".to_string()
    };
    out.risk = if out.proxy {
        "高".to_string()
    } else if out.hosting {
        "中".to_string()
    } else if out.country.is_some() {
        "低".to_string()
    } else {
        "未知".to_string()
    };
    let mut score: i32 = 100;
    if out.hosting {
        score -= 28;
    }
    if out.proxy {
        score -= 40;
    }
    if out.mobile {
        score -= 5;
    }
    out.score = score.clamp(0, 100) as u8;
    Ok(out)
}
