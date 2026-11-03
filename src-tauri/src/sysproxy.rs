use std::process::Command;

#[derive(serde::Serialize)]
pub struct SysProxyState {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
}

#[cfg(target_os = "windows")]
fn reg(args: &[&str]) -> Result<String, String> {
    let out = Command::new("reg")
        .args(args)
        .output()
        .map_err(|e| format!("执行 reg 失败：{e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[cfg(target_os = "windows")]
fn refresh_wininet() {
    // 通知 WinINet 设置已变化；失败不阻塞代理开关。
    let script = r#"Add-Type -Namespace PPClash -Name WinINet -MemberDefinition '[DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);'; [PPClash.WinINet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null"#;
    let _ = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .status();
}

#[cfg(target_os = "windows")]
fn set_windows_proxy(enable: bool, host: &str, port: u16) -> Result<(), String> {
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    let enable_value = if enable { "1" } else { "0" };
    let server = format!("{host}:{port}");
    reg(&["add", key, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", enable_value, "/f"])?;
    if enable {
        reg(&["add", key, "/v", "ProxyServer", "/t", "REG_SZ", "/d", &server, "/f"])?;
        reg(&[
            "add", key, "/v", "ProxyOverride", "/t", "REG_SZ", "/d", "localhost;127.*;<local>",
            "/f",
        ])?;
    }
    refresh_wininet();
    Ok(())
}

#[cfg(target_os = "windows")]
fn get_windows_proxy() -> SysProxyState {
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    let enabled = reg(&["query", key, "/v", "ProxyEnable"])
        .ok()
        .map(|s| s.contains("0x1"))
        .unwrap_or(false);
    let server = reg(&["query", key, "/v", "ProxyServer"])
        .ok()
        .and_then(|s| s.split("REG_SZ").nth(1).map(|v| v.trim().to_string()))
        .unwrap_or_default();
    let (host, port) = server
        .rsplit_once(':')
        .map(|(h, p)| (h.to_string(), p.parse().unwrap_or(0)))
        .unwrap_or((server, 0));
    SysProxyState {
        enabled,
        host,
        port,
    }
}

/// 列出所有网络服务名（Wi-Fi、以太网…）。
///
/// macOS 的系统代理是**按网络服务**设置的，只设 Wi-Fi 的话插网线就不生效。
fn list_services() -> Vec<String> {
    let out = match Command::new("networksetup").arg("-listallnetworkservices").output() {
        Ok(o) => o,
        Err(_) => return vec![],
    };

    String::from_utf8_lossy(&out.stdout)
        .lines()
        .skip(1) // 第一行是 "An asterisk (*) denotes that a network service is disabled."
        .map(|l| l.trim().trim_start_matches('*').trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

fn run(args: &[&str]) -> Result<(), String> {
    let out = Command::new("networksetup")
        .args(args)
        .output()
        .map_err(|e| format!("执行 networksetup 失败：{e}"))?;

    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// 开启 / 关闭系统代理。
#[tauri::command]
pub fn set_system_proxy(enable: bool, host: String, port: u16) -> Result<SysProxyState, String> {
    #[cfg(target_os = "windows")]
    {
        set_windows_proxy(enable, &host, port)?;
        return Ok(SysProxyState { enabled: enable, host, port });
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (enable, host, port);
        return Err("当前平台暂未实现系统代理设置".to_string());
    }
    #[cfg(target_os = "macos")]
    {

    let port_str = port.to_string();
    let services = list_services();
    if services.is_empty() {
        return Err("没有找到可用的网络服务".to_string());
    }

    let mut errors: Vec<String> = Vec::new();

    for svc in &services {
        let res = if enable {
            run(&["-setwebproxy", svc, &host, &port_str])
                .and_then(|_| run(&["-setsecurewebproxy", svc, &host, &port_str]))
                .and_then(|_| run(&["-setwebproxystate", svc, "on"]))
                .and_then(|_| run(&["-setsecurewebproxystate", svc, "on"]))
        } else {
            run(&["-setwebproxystate", svc, "off"])
                .and_then(|_| run(&["-setsecurewebproxystate", svc, "off"]))
        };

        if let Err(e) = res {
            errors.push(format!("{svc}: {e}"));
        }
    }

    // 全部失败才算失败；部分服务不可写（如已停用的接口）是正常的
    if errors.len() == services.len() {
        return Err(errors.join("; "));
    }

    Ok(SysProxyState {
        enabled: enable,
        host,
        port,
    })
    }
}

/// 查询当前是否已设置系统代理。
#[tauri::command]
pub fn get_system_proxy() -> Result<SysProxyState, String> {
    #[cfg(target_os = "windows")]
    {
        return Ok(get_windows_proxy());
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        return Ok(SysProxyState {
            enabled: false,
            host: String::new(),
            port: 0,
        });
    }
    #[cfg(target_os = "macos")]
    {

    let services = list_services();
    for svc in &services {
        if let Ok(out) = Command::new("networksetup")
            .args(["-getwebproxy", svc])
            .output()
        {
            let text = String::from_utf8_lossy(&out.stdout);
            let enabled = text.lines().any(|l| l.trim() == "Enabled: Yes");
            if enabled {
                let host = text
                    .lines()
                    .find(|l| l.starts_with("Server:"))
                    .map(|l| l[7..].trim().to_string())
                    .unwrap_or_default();
                let port = text
                    .lines()
                    .find(|l| l.starts_with("Port:"))
                    .and_then(|l| l[5..].trim().parse().ok())
                    .unwrap_or(0);
                return Ok(SysProxyState {
                    enabled: true,
                    host,
                    port,
                });
            }
        }
    }

    Ok(SysProxyState {
        enabled: false,
        host: String::new(),
        port: 0,
    })
}
    }
