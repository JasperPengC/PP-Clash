use std::process::Command;

#[derive(serde::Serialize)]
pub struct SysProxyState {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
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
    if !cfg!(target_os = "macos") {
        return Err("当前平台暂未实现系统代理设置".to_string());
    }

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

/// 查询当前是否已设置系统代理。
#[tauri::command]
pub fn get_system_proxy() -> Result<SysProxyState, String> {
    if !cfg!(target_os = "macos") {
        return Ok(SysProxyState {
            enabled: false,
            host: String::new(),
            port: 0,
        });
    }

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
