use std::process::Command;

#[derive(serde::Serialize)]
pub struct SysProxyState {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
}

#[cfg(target_os = "windows")]
fn reg(args: &[&str]) -> Result<String, String> {
    let out = crate::platform::command("reg")
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
    // 直接调用 WinINet，避免为刷新代理再启动一个 PowerShell（既慢又会闪控制台）。
    use windows_sys::Win32::Networking::WinInet::{
        InternetSetOptionW, INTERNET_OPTION_REFRESH, INTERNET_OPTION_SETTINGS_CHANGED,
    };
    unsafe {
        InternetSetOptionW(std::ptr::null(), INTERNET_OPTION_SETTINGS_CHANGED, std::ptr::null(), 0);
        InternetSetOptionW(std::ptr::null(), INTERNET_OPTION_REFRESH, std::ptr::null(), 0);
    }
}

#[cfg(target_os = "windows")]
fn set_windows_proxy(enable: bool, host: &str, port: u16) -> Result<(), String> {
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    if !enable {
        let current = get_windows_proxy();
        if !current.enabled || current.host != host || current.port != port {
            return Ok(()); // 不是本应用设置的代理，不要动
        }
    }
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
    let out = match crate::platform::command("networksetup").arg("-listallnetworkservices").output() {
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
    let out = crate::platform::command("networksetup")
        .args(args)
        .output()
        .map_err(|e| format!("执行 networksetup 失败：{e}"))?;

    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(target_os = "macos")]
fn proxy_is_ours(service: &str, host: &str, port: u16) -> bool {
    let Ok(out) = crate::platform::command("networksetup")
        .args(["-getwebproxy", service])
        .output()
    else {
        return false;
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let enabled = text.lines().any(|l| l.trim() == "Enabled: Yes");
    let server = text
        .lines()
        .find(|l| l.starts_with("Server:"))
        .map(|l| l[7..].trim())
        .unwrap_or("");
    let p = text
        .lines()
        .find(|l| l.starts_with("Port:"))
        .and_then(|l| l[5..].trim().parse::<u16>().ok())
        .unwrap_or(0);
    enabled && server == host && p == port
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
        } else if proxy_is_ours(svc, &host, port) {
            // 只关闭仍指向本应用端口的代理，避免误伤其它客户端
            run(&["-setwebproxystate", svc, "off"])
                .and_then(|_| run(&["-setsecurewebproxystate", svc, "off"]))
        } else {
            Ok(())
        };

        if let Err(e) = res {
            errors.push(format!("{svc}: {e}"));
        }
    }

    // 全部失败才算失败；部分服务不可写（如已停用的接口）是正常的
    if errors.len() == services.len() {
        return Err(errors.join("; "));
    }
    if !enable {
        // 关闭后仍指向本端口的服务：不要假装成功，上层会保留内核避免断网
        let still = services
            .iter()
            .filter(|svc| proxy_is_ours(svc, &host, port))
            .cloned()
            .collect::<Vec<_>>();
        if !still.is_empty() {
            return Err(format!("系统代理未完全关闭：{}", still.join(", ")));
        }
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
        if let Ok(out) = crate::platform::command("networksetup")
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
