//! 概览页服务连通性探测。
//!
//! 通过 mihomo 的 mixed 端口发请求：系统代理/TUN 模式下都能反映真实出口质量。

use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Manager;

#[derive(Debug, Serialize)]
pub struct ServiceProbe {
    pub id: String,
    pub ok: bool,
    pub latency_ms: Option<u64>,
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
    let url = format!("https://ipwho.is/{ip}");
    let Ok(resp) = client.get(url).send().await else {
        return Ok(IpCountry { country: None, country_code: None });
    };
    let Ok(text) = resp.text().await else {
        return Ok(IpCountry { country: None, country_code: None });
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Ok(IpCountry { country: None, country_code: None });
    };
    Ok(IpCountry {
        country: v.get("country").and_then(|x| x.as_str()).map(str::to_string),
        country_code: v
            .get("country_code")
            .and_then(|x| x.as_str())
            .map(str::to_string),
    })
}

const TARGETS: [(&str, &str); 5] = [
    ("google", "https://www.google.com/generate_204"),
    ("youtube", "https://www.youtube.com/generate_204"),
    ("github", "https://github.com/"),
    ("openai", "https://chatgpt.com/"),
    ("anthropic", "https://www.anthropic.com/"),
];

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
        Ok(client) => match client.get(url).send().await {
            Ok(resp) => resp.status().is_success() || resp.status().is_redirection(),
            Err(_) => false,
        },
        Err(_) => false,
    };
    ServiceProbe {
        id: id.to_string(),
        ok,
        latency_ms: ok.then_some(started.elapsed().as_millis() as u64),
    }
}

/// 单个服务探测：前端并发调用，谁先完成谁先渲染。
#[tauri::command]
pub async fn probe_service_auto(app: tauri::AppHandle, id: String) -> Result<ServiceProbe, String> {
    let Some((target_id, url)) = TARGETS.iter().find(|(key, _)| *key == id) else {
        return Err("未知服务".to_string());
    };
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
        ServiceProbe { id: TARGETS[0].0.to_string(), ok: a.0, latency_ms: a.1 },
        ServiceProbe { id: TARGETS[1].0.to_string(), ok: b.0, latency_ms: b.1 },
        ServiceProbe { id: TARGETS[2].0.to_string(), ok: c.0, latency_ms: c.1 },
        ServiceProbe { id: TARGETS[3].0.to_string(), ok: d.0, latency_ms: d.1 },
        ServiceProbe { id: TARGETS[4].0.to_string(), ok: e.0, latency_ms: e.1 },
    ])
}

