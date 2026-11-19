use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

use super::Vpn;
use crate::{mihomo, platform, subscription};

pub(crate) fn mobile_config(content: &str) -> Result<String, String> {
    let mut value: serde_json::Value = serde_json::from_str(content).map_err(|e| format!("配置格式错误：{e}"))?;
    let config = value.as_object_mut().ok_or("需要键值对配置")?;
    let controller = config.get("external-controller").and_then(|v| v.as_str());
    if !controller.and_then(|value| value.strip_prefix("127.0.0.1:"))
        .and_then(|port| port.parse::<u16>().ok()).is_some_and(|port| port > 0)
        || !config.get("secret").and_then(|v| v.as_str()).is_some_and(|secret| !secret.is_empty())
    {
        return Err("仅允许带密钥的本机控制器".into());
    }
    // Android system VPN owns the route and its tunnel descriptor independently of config reloads.
    config.insert("tun".into(), json!({ "enable": false }));
    config.insert("allow-lan".into(), json!(false));
    config.insert("bind-address".into(), json!("127.0.0.1"));
    config.insert("redir-port".into(), json!(0));
    config.insert("tproxy-port".into(), json!(0));
    config.insert("find-process-mode".into(), json!("off"));
    for desktop in ["external-controller-tls", "external-controller-unix", "external-controller-pipe",
        "external-doh-server", "external-ui", "external-ui-url", "iptables"] {
        config.remove(desktop);
    }
    serde_json::to_string(&value).map_err(|e| e.to_string())
}

pub(crate) struct KernelState {
    pub(crate) controller_port: Mutex<u16>,
    pub(crate) controller_secret: Mutex<String>,
    transition: Mutex<()>,
}

impl Default for KernelState {
    fn default() -> Self {
        Self {
            controller_port: Mutex::new(9090),
            controller_secret: Mutex::new(String::new()),
            transition: Mutex::new(()),
        }
    }
}

#[derive(Deserialize, Serialize)]
pub struct KernelStatus {
    running: bool,
    pid: Option<u32>,
    #[serde(default)]
    reclaimed: Vec<u32>,
}

fn local_config(config_path: String) -> Result<PathBuf, String> {
    let path = PathBuf::from(config_path).canonicalize().map_err(|e| format!("读取配置失败：{e}"))?;
    let dir = platform::data_dir()?.canonicalize().map_err(|e| format!("读取应用目录失败：{e}"))?;
    if path.parent() != Some(dir.as_path()) || !path.is_file() {
        return Err("配置文件不在应用数据目录".into());
    }
    Ok(path)
}

#[tauri::command]
pub async fn validate_config(app: AppHandle, config_path: String) -> Result<(), String> {
    let path = local_config(config_path)?;
    let digest = subscription::config_digest(&path)?;
    app.state::<Vpn>().0.run_mobile_plugin_async::<serde_json::Value>(
        "validateConfig", json!({ "path": path }),
    ).await.map_err(|err| err.to_string())?;
    subscription::mark_config_validated(&path, &digest)
}

#[tauri::command]
pub async fn start_kernel(app: AppHandle, config_path: String, controller_port: u16, controller_secret: String) -> Result<KernelStatus, String> {
    let state = app.state::<KernelState>();
    let _guard = state.transition.lock().await;
    let path = local_config(config_path)?;
    if path.file_name().and_then(|part| part.to_str()) != Some("config.yaml") || controller_secret.is_empty() {
        return Err("VPN 需要已校验的配置与控制器密钥".into());
    }
    let vpn = app.state::<Vpn>();
    let status: KernelStatus = vpn.0.run_mobile_plugin_async("startVpn", json!({ "path": path })).await
        .map_err(|err| err.to_string())?;
    if !status.running {
        return Err("VPN 服务未运行".into());
    }
    let base = format!("http://127.0.0.1:{controller_port}");
    for _ in 0..20 {
        let ready = tokio::time::timeout(Duration::from_millis(400),
            mihomo::request(&base, &controller_secret, "GET", "/version", None)).await;
        if matches!(ready, Ok(Ok(_))) {
            *state.controller_port.lock().await = controller_port;
            *state.controller_secret.lock().await = controller_secret;
            return Ok(status);
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    vpn.0.run_mobile_plugin_async::<KernelStatus>("stopVpn", json!({})).await
        .map_err(|err| format!("控制器未就绪，VPN 停止失败：{err}"))?;
    Err("内核控制器未就绪".into())
}

#[tauri::command]
pub async fn stop_kernel(app: AppHandle) -> Result<KernelStatus, String> {
    let state = app.state::<KernelState>();
    let _guard = state.transition.lock().await;
    app.state::<Vpn>().0.run_mobile_plugin_async("stopVpn", json!({})).await.map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn kernel_status(app: AppHandle, secret: String, port: Option<u16>) -> Result<KernelStatus, String> {
    let status: KernelStatus = app.state::<Vpn>().0.run_mobile_plugin_async("vpnStatus", json!({})).await
        .map_err(|err| err.to_string())?;
    if status.running {
        let state = app.state::<KernelState>();
        if let Some(port) = port { *state.controller_port.lock().await = port; }
        *state.controller_secret.lock().await = secret;
    }
    Ok(status)
}

#[tauri::command]
pub async fn read_kernel_log(app: AppHandle, lines: usize) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Lines { text: String }
    app.state::<Vpn>().0.run_mobile_plugin_async::<Lines>("readLog", json!({ "lines": lines.min(1000) })).await
        .map(|entry| entry.text).map_err(|err| err.to_string())
}
