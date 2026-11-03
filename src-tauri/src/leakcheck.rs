//! 泄漏自检（M3-3）：实测出口 IP、DNS 接管与内核 DNS 端口。
//!
//! 只做「能在本机诚实测到」的事，不做花架子：
//!   · 出口 IP：直连 vs 经 mihomo 混合端口，两者一致 = 代理未生效
//!   · DNS：系统解析（getaddrinfo）是否落进 Fake-IP 网段（198.18.0.0/15）
//!     ——TUN 的 dns-hijack 生效时 getaddrinfo 会被劫持返回 Fake-IP
//!   · 内核 DNS：直接 UDP 查询 127.0.0.1:1053（security.ts 里固定监听的端口）
//! WebRTC 在前端 WebView 里测（见 core/selfcheck.ts），不在 Rust 侧。

use std::net::{Ipv4Addr, ToSocketAddrs, UdpSocket};
use std::time::Duration;

use serde::Serialize;

#[derive(Serialize)]
pub struct IpCheck {
    pub direct: Option<String>,
    pub proxied: Option<String>,
}

#[derive(Serialize)]
pub struct DnsCheck {
    /// 内核 DNS 端口（1053）是否应答
    pub kernel_alive: bool,
    /// 内核 DNS 是否返回 Fake-IP
    pub kernel_fake_ip: bool,
    /// 系统解析（getaddrinfo）结果
    pub system_ips: Vec<String>,
    /// 系统解析是否落进 Fake-IP 网段（= TUN DNS 劫持已生效）
    pub system_fake_ip: bool,
}

/// 探测公网出口 IP。proxy 为 None 时强制直连（no_proxy，无视环境变量）。
async fn fetch_exit_ip(proxy_port: Option<u16>) -> Option<String> {
    let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(8));
    builder = match proxy_port {
        Some(p) => builder.proxy(reqwest::Proxy::all(format!("http://127.0.0.1:{p}")).ok()?),
        None => builder.no_proxy(),
    };
    let client = builder.build().ok()?;

    // 双源兜底：任一可用即返回
    for url in ["https://api.ipify.org", "https://ifconfig.me/ip"] {
        if let Ok(resp) = client
            .get(url)
            .header("User-Agent", "PPClash/0.1")
            .send()
            .await
        {
            if resp.status().is_success() {
                if let Ok(t) = resp.text().await {
                    let t = t.trim().to_string();
                    // HTML 错误页/IP 极端值防御
                    if !t.is_empty() && t.len() <= 64 {
                        return Some(t);
                    }
                }
            }
        }
    }
    None
}

#[tauri::command]
pub async fn leak_check_ip(mixed_port: u16, tun_enabled: bool) -> Result<IpCheck, String> {
    let proxied = fetch_exit_ip(Some(mixed_port)).await;
    // TUN 会把「直连」请求也劫持进内核，此时对比直连/代理出口没有意义，
    // 反而会误报「代理未生效」。TUN 开启时不取 direct。
    let direct = if tun_enabled { None } else { fetch_exit_ip(None).await };
    Ok(IpCheck { direct, proxied })
}

/// 手工拼一个最小 DNS A 查询（不需要引第三方 DNS 库）。
fn build_query(domain: &str) -> Vec<u8> {
    let mut p = vec![0x1a, 0x2b, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    for part in domain.split('.') {
        p.push(part.len() as u8);
        p.extend_from_slice(part.as_bytes());
    }
    p.extend_from_slice(&[0x00, 0x00, 0x01, 0x00, 0x01]); // A IN
    p
}

/// 跳过 DNS 报文里的名字字段（含压缩指针）。
fn skip_name(buf: &[u8], mut i: usize) -> Option<usize> {
    loop {
        let len = *buf.get(i)?;
        if len & 0xC0 == 0xC0 {
            return Some(i + 2);
        }
        if len == 0 {
            return Some(i + 1);
        }
        i += 1 + len as usize;
    }
}

fn parse_a_answers(buf: &[u8]) -> Vec<String> {
    let mut out = vec![];
    if buf.len() < 12 {
        return out;
    }
    let qd = u16::from_be_bytes([buf[4], buf[5]]) as usize;
    let an = u16::from_be_bytes([buf[6], buf[7]]) as usize;

    let mut i = 12;
    for _ in 0..qd {
        i = match skip_name(buf, i) {
            Some(x) => x + 4, // QTYPE + QCLASS
            None => return out,
        };
    }
    for _ in 0..an {
        i = match skip_name(buf, i) {
            Some(x) => x,
            None => return out,
        };
        if i + 10 > buf.len() {
            return out;
        }
        let typ = u16::from_be_bytes([buf[i], buf[i + 1]]);
        let rdlen = u16::from_be_bytes([buf[i + 8], buf[i + 9]]) as usize;
        let rd = i + 10;
        if typ == 1 && rdlen == 4 && rd + 4 <= buf.len() {
            out.push(format!(
                "{}.{}.{}.{}",
                buf[rd], buf[rd + 1], buf[rd + 2], buf[rd + 3]
            ));
        }
        i = rd + rdlen;
    }
    out
}

/// 向内核 DNS（默认 127.0.0.1:1053，端口由设置决定）发一次 A 查询。
fn udp_dns_query(domain: &str, dns_port: u16) -> Vec<String> {
    let sock = match UdpSocket::bind("0.0.0.0:0") {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    if sock.set_read_timeout(Some(Duration::from_secs(3))).is_err() {
        return vec![];
    }
    if sock.connect(("127.0.0.1", dns_port)).is_err() {
        return vec![];
    }
    if sock.send(&build_query(domain)).is_err() {
        return vec![];
    }
    let mut buf = [0u8; 1024];
    match sock.recv(&mut buf) {
        Ok(n) => parse_a_answers(&buf[..n]),
        Err(_) => vec![],
    }
}

fn is_fake_ip(ips: &[String]) -> bool {
    ips.iter().any(|s| {
        s.parse::<Ipv4Addr>()
            .map(|ip| {
                // Fake-IP 网段 198.18.0.0/15
                ip.octets()[0] == 198 && (ip.octets()[1] == 18 || ip.octets()[1] == 19)
            })
            .unwrap_or(false)
    })
}

#[tauri::command]
pub async fn leak_check_dns(domain: String, dns_port: u16) -> Result<DnsCheck, String> {
    let d = domain.clone();
    let kernel = tauri::async_runtime::spawn_blocking(move || udp_dns_query(&d, dns_port))
        .await
        .map_err(|e| e.to_string())?;

    let d2 = domain;
    let system = tauri::async_runtime::spawn_blocking(move || {
        let ips = (d2.as_str(), 0)
            .to_socket_addrs()
            .map(|it| it.map(|a| a.ip().to_string()).collect::<Vec<_>>())
            .unwrap_or_default();
        ips
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(DnsCheck {
        kernel_alive: !kernel.is_empty(),
        kernel_fake_ip: is_fake_ip(&kernel),
        system_fake_ip: is_fake_ip(&system),
        system_ips: system,
    })
}
