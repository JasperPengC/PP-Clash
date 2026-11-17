//! 诊断日志与一键诊断包。
//!
//! 目标：长时间运行出问题时，用户能直接导出一个不包含订阅正文/密码的 zip，
//! 里面有 app.log、kernel.log、脱敏状态、系统信息和端口状态。

use std::io::{Read, Seek, SeekFrom, Write};
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
    let Ok(mut file) = std::fs::File::open(path) else {
        return String::new();
    };
    let length = file.metadata().map(|m| m.len()).unwrap_or(0);
    if file.seek(SeekFrom::Start(length.saturating_sub(max as u64))).is_err() {
        return String::new();
    }
    let mut bytes = Vec::with_capacity(max.min(length as usize));
    if file.take(max as u64).read_to_end(&mut bytes).is_err() { return String::new(); }
    String::from_utf8_lossy(&bytes).to_string()
}

fn redact(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for key in [
                "url",
                "raw",
                "authUser",
                "authPass",
                "controllerSecret",
                "dnsCustom",
                "overrideText",
                "updateFeedUrl",
                "subscriptionUserinfo",
                "text",
                "password",
                "uuid",
                "secret",
                "token",
                "authorization",
                "authentication",
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

fn redact_log(text: &str, secrets: &[String]) -> String {
    // 先检查原始行，避免已知秘密替换恰好破坏 password 等字段名。
    let sensitive = regex::Regex::new(r#"(?i)(?:uuid|password|passwd|secret|token|authorization|authentication|authpass|authuser|bearer|api[-_]?key)\s*[\"':= ]"#).expect("static regex");
    let mut clean = text.lines().map(|line| {
        if sensitive.is_match(line) { "[redacted sensitive log line]" } else { line }
    }).collect::<Vec<_>>().join("\n");
    // 先替换完整长凭据，避免其前缀被替换后留下其余敏感内容。
    let mut ordered_secrets: Vec<&str> = secrets.iter().map(String::as_str).filter(|value| !value.is_empty()).collect();
    ordered_secrets.sort_unstable_by_key(|value| std::cmp::Reverse(value.len()));
    for secret in ordered_secrets {
        clean = clean.replace(secret, "[redacted]");
    }
    let urls = regex::Regex::new(r#"(?i)\b[a-z][a-z0-9+.-]*://[^\s<>\"']+"#).expect("static regex");
    urls.replace_all(&clean, "[redacted URL]").into_owned()
}

fn collect_secrets(value: &Value, secrets: &mut Vec<String>) {
    match value {
        Value::Object(map) => for (key, value) in map {
            if matches!(key.to_ascii_lowercase().as_str(), "uuid" | "password" | "secret" | "token" | "authorization" | "authpass" | "authuser" | "controllersecret" | "url" | "dnscustom") {
                if let Some(text) = value.as_str().filter(|text| !text.is_empty()) { secrets.push(text.to_string()); }
            }
            // 仅在导出时解析有大小上限的正文，保留引号、转义和多行标量的完整语义。
            // 无法解析或过大的正文不回显解析错误，日志仍按敏感字段行保守脱敏。
            if matches!(key.as_str(), "raw" | "text" | "overrideText") {
                if let Some(text) = value.as_str().filter(|text| text.len() <= 2 * 1024 * 1024) {
                    if let Ok(body) = serde_json::from_str::<Value>(text)
                        .or_else(|_| {
                            let mut options = serde_saphyr::Options::default();
                            options.budget = serde_saphyr::budget! {
                                max_events: 250_000,
                                max_nodes: 100_000,
                                max_depth: 64,
                                flow_nesting_limit: 64,
                                max_documents: 1,
                                max_inclusion_depth: 0,
                                max_anchors: 4_096,
                                max_aliases: 16_384,
                                max_recorded_anchor_events: 250_000,
                                max_recorded_anchor_bytes: 2 * 1024 * 1024,
                                max_total_scalar_bytes: 2 * 1024 * 1024,
                            };
                            options.alias_limits.max_total_replayed_events = 250_000;
                            options.alias_limits.max_replay_stack_depth = 32;
                            options.alias_limits.max_alias_expansions_per_anchor = 4_096;
                            options.with_snippet = false;
                            serde_saphyr::from_str_with_options::<Value>(text, options)
                        })
                    {
                        collect_secrets(&body, secrets);
                    }
                }
            }
            collect_secrets(value, secrets);
        },
        Value::Array(items) => for item in items { collect_secrets(item, secrets); },
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
    let mut secrets = Vec::new();
    let state_out = if state_text.trim().is_empty() {
        "[no state.json]".to_string()
    } else {
        match serde_json::from_str::<Value>(&state_text) {
            Ok(mut v) => {
                collect_secrets(&v, &mut secrets);
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
        let text = redact_log(&tail_text(&path, max), &secrets);
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
    fn redacts_override_bodies_and_nested_credentials() {
        let mut v = serde_json::json!({
            "settings": {"overrides": [{"name": "custom", "mode": "yaml", "enabled": true,
                "text": "password: synthetic-override"}]},
            "nested": {"password": "synthetic-node", "secret": "synthetic-controller", "token": "synthetic-token"}
        });
        redact(&mut v);
        let text = v.to_string();
        assert!(!text.contains("synthetic-"));
        assert!(text.contains("custom"));
        assert!(text.contains("yaml"));
    }

    #[test]
    fn exported_log_hides_urls_credentials_and_known_secret_values() {
        let log = "[warn] request https://example.test/sub?token=synthetic-url failed\n[error] password: synthetic-password\n[error] Bearer synthetic-bearer\n[warn] config rejected synthetic-known\n[info] controller timeout";
        let cleaned = redact_log(log, &["synthetic-known".to_string()]);
        assert!(!cleaned.contains("synthetic-"));
        assert!(cleaned.contains("controller timeout"));
    }

    #[test]
    fn current_vless_uuid_is_redacted_from_unlabelled_log() {
        let uuid = "00000000-0000-4000-8000-000000000001";
        let state = serde_json::json!({
            "profiles": [{"raw": format!("proxies: [{{name: synthetic, type: vless, uuid: '{uuid}'}}]")}]
        });
        let mut secrets = Vec::new();
        collect_secrets(&state, &mut secrets);
        let clean = redact_log(&format!("[warn] rejected value {uuid}"), &secrets);
        assert!(!clean.contains(uuid));
    }

    #[test]
    fn uuid_labelled_log_is_redacted_without_current_state() {
        let clean = redact_log("[warn] invalid uuid 00000000-0000-4000-8000-000000000001", &[]);
        assert!(!clean.contains("00000000-0000-4000-8000-000000000001"));
    }

    #[test]
    fn complete_yaml_credentials_are_redacted_from_unlabelled_log() {
        for raw in [
            "proxies: [{password: 'synthetic phrase value'}]",
            "proxies:\n  - password: >-\n      synthetic phrase\n      value\n",
            r#"{"proxies":[{"password":"synthetic phrase value"}]}"#,
        ] {
            let state = serde_json::json!({"profiles": [{"raw": raw}]});
            let mut secrets = Vec::new();
            collect_secrets(&state, &mut secrets);
            let clean = redact_log("[warn] rejected value synthetic phrase value", &secrets);
            assert!(!clean.contains("synthetic"), "{clean}");
            assert!(!clean.contains("phrase value"), "{clean}");
        }
    }

    #[test]
    fn uuid_and_custom_dns_credentials_are_redacted_from_state() {
        let mut state = serde_json::json!({
            "settings": {"dnsCustom": "https://example.test/dns-query?key=synthetic-dns"},
            "nested": {"uuid": "00000000-0000-4000-8000-000000000001"}
        });
        redact(&mut state);
        let clean = state.to_string();
        assert!(!clean.contains("synthetic-dns"));
        assert!(!clean.contains("00000000-0000-4000-8000-000000000001"));
    }

    #[test]
    fn longer_known_credentials_are_redacted_before_their_prefixes() {
        let state = serde_json::json!({
            "authPass": "synthetic",
            "profiles": [{"raw": "proxies: [{password: 'synthetic phrase value'}]"}]
        });
        let mut secrets = Vec::new();
        collect_secrets(&state, &mut secrets);
        let clean = redact_log("[warn] rejected value synthetic phrase value", &secrets);
        assert!(!clean.contains("phrase value"), "{clean}");
    }

    #[test]
    fn unparsed_bodies_keep_sensitive_log_lines_hidden() {
        for raw in [
            "proxies: [{password: 'synthetic phrase value'".to_string(),
            format!("password: 'synthetic phrase value'\n#{}", "x".repeat(3 * 1024 * 1024)),
        ] {
            let state = serde_json::json!({"profiles": [{"raw": raw}]});
            let mut secrets = Vec::new();
            collect_secrets(&state, &mut secrets);
            let clean = redact_log("[warn] password: synthetic phrase value\n[info] controller timeout", &secrets);
            assert!(!clean.contains("synthetic"));
            assert!(!clean.contains("phrase value"));
            assert!(clean.contains("controller timeout"));
        }
    }

    #[test]
    fn known_secret_matching_a_field_name_does_not_disable_line_redaction() {
        let clean = redact_log("[warn] password: synthetic-unparsed", &["pass".to_string()]);
        assert!(!clean.contains("synthetic-unparsed"));
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
