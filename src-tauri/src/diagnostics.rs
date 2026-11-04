//! 诊断日志与一键诊断包。
//!
//! 目标：长时间运行出问题时，用户能直接导出一个不包含订阅正文/密码的 zip，
//! 里面有 app.log、kernel.log、脱敏状态、系统信息和端口状态。

use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use zip::write::SimpleFileOptions;

use crate::resources;

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn data_dir() -> Result<std::path::PathBuf, String> {
    resources::data_dir()
}

fn log_path() -> Result<std::path::PathBuf, String> {
    Ok(data_dir()?.join("app.log"))
}

/// 前端把关键事件/错误写入 app.log；单文件超过 4MB 时滚动一次。
#[tauri::command]
pub fn append_diagnostic_log(level: String, message: String) -> Result<(), String> {
    let dir = data_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("app.log");
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > 4 * 1024 * 1024 {
        let _ = std::fs::rename(&path, dir.join("app.log.1"));
    }
    let line = format!(
        "[{}] [{}] {}\n",
        now_secs(),
        level,
        message.replace(['\r', '\n'], " ")
    );
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.write_all(line.as_bytes()).map_err(|e| e.to_string())
}

fn tail_text(path: &std::path::Path, max: usize) -> String {
    let Ok(bytes) = std::fs::read(path) else {
        return String::new();
    };
    let slice = if bytes.len() > max {
        &bytes[bytes.len() - max..]
    } else {
        &bytes[..]
    };
    String::from_utf8_lossy(slice).to_string()
}

fn redact(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for key in [
                "url",
                "raw",
                "authUser",
                "authPass",
                "overrideText",
                "updateFeedUrl",
                "subscriptionUserinfo",
            ] {
                if map.contains_key(key) {
                    map.insert(key.to_string(), Value::String("[redacted]".to_string()));
                }
            }
            for v in map.values_mut() {
                redact(v);
            }
        }
        Value::Array(items) => {
            for v in items {
                redact(v);
            }
        }
        _ => {}
    }
}

fn port_open(port: u16) -> bool {
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

#[tauri::command]
pub async fn export_diagnostics(app: tauri::AppHandle) -> Result<String, String> {
    let dir = data_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out_dir = dir.join("diagnostics");
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let stamp = now_secs();
    let zip_path = out_dir.join(format!("PPClash-diagnostics-{stamp}.zip"));
    let file = std::fs::File::create(&zip_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    // 基础信息
    let running = crate::kernel::is_running(&app).await;
    let sys_proxy = crate::sysproxy::get_system_proxy()
        .map(|s| format!("enabled={} host={} port={}", s.enabled, s.host, s.port))
        .unwrap_or_else(|e| format!("error={e}"));
    let os = format!(
        "{} {} {}",
        std::env::consts::OS,
        std::env::consts::ARCH,
        std::env::consts::FAMILY
    );
    let mut info = format!(
        "PP Clash diagnostics\nversion={}\nos={}\npid={}\nexe={:?}\ndata_dir={:?}\nkernel_running={}\nsystem_proxy={}\nexported_at_unix={}\n",
        env!("CARGO_PKG_VERSION"),
        os,
        std::process::id(),
        std::env::current_exe().ok(),
        dir,
        running,
        sys_proxy,
        stamp
    );
    // 端口状态
    if let Ok(raw) = std::fs::read_to_string(dir.join("state.json")) {
        if let Ok(v) = serde_json::from_str::<Value>(&raw) {
            if let Some(s) = v.get("settings") {
                let mixed = s.get("mixedPort").and_then(Value::as_u64).unwrap_or(0) as u16;
                let controller = s.get("controllerPort").and_then(Value::as_u64).unwrap_or(0) as u16;
                let dns = s.get("dnsPort").and_then(Value::as_u64).unwrap_or(0) as u16;
                info.push_str(&format!(
                    "ports mixed={mixed}({}) controller={controller}({}) dns={dns}({})\n",
                    port_open(mixed),
                    port_open(controller),
                    port_open(dns)
                ));
            }
        }
    }
    zip.start_file("system.txt", opts).map_err(|e| e.to_string())?;
    zip.write_all(info.as_bytes()).map_err(|e| e.to_string())?;

    // 脱敏状态
    let state_text = std::fs::read_to_string(dir.join("state.json")).unwrap_or_default();
    let state_out = if state_text.trim().is_empty() {
        "[no state.json]".to_string()
    } else {
        match serde_json::from_str::<Value>(&state_text) {
            Ok(mut v) => {
                redact(&mut v);
                serde_json::to_string_pretty(&v).unwrap_or_else(|_| "[invalid state]".into())
            }
            Err(_) => "[invalid state.json]".to_string(),
        }
    };
    zip.start_file("state.redacted.json", opts).map_err(|e| e.to_string())?;
    zip.write_all(state_out.as_bytes()).map_err(|e| e.to_string())?;

    // 日志
    for (name, path, max) in [
        ("app.log", log_path().unwrap_or_default(), 1024 * 1024),
        ("app.log.1", dir.join("app.log.1"), 1024 * 1024),
        ("kernel.log", dir.join("kernel.log"), 2 * 1024 * 1024),
    ] {
        if path.as_os_str().is_empty() {
            continue;
        }
        let text = tail_text(&path, max);
        if !text.is_empty() {
            zip.start_file(name, opts).map_err(|e| e.to_string())?;
            zip.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        }
    }

    zip.finish().map_err(|e| e.to_string())?;
    Ok(zip_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_sensitive_fields() {
        let mut v = serde_json::json!({
            "profiles": [{"name": "x", "url": "https://secret", "raw": "proxies: [x]"}],
            "settings": {"authPass": "p", "authUser": "u"},
            "nested": {"updateFeedUrl": "https://feed"}
        });
        redact(&mut v);
        let text = serde_json::to_string(&v).unwrap();
        assert!(!text.contains("secret"));
        assert!(!text.contains("authPass\":\"p"));
        assert!(text.contains("[redacted]"));
    }

    #[test]
    fn tail_keeps_last_bytes() {
        let dir = std::env::temp_dir().join(format!("ppclash-diag-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("x.log");
        std::fs::write(&path, "0123456789").unwrap();
        assert_eq!(tail_text(&path, 4), "6789");
        let _ = std::fs::remove_dir_all(dir);
    }
}
