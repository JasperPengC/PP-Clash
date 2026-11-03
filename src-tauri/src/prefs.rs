use std::path::PathBuf;
use std::sync::Mutex;

use crate::subscription::resolve_data_dir;
use tauri::Manager;

/// 跨窗口/前后端共享的状态标志。
///
/// 前端是唯一写入口（set_tray_flags），托盘菜单读这里重建，
/// 事件驱动同步，不做轮询。
pub struct AppFlags {
    pub close_to_tray: Mutex<bool>,
    /// 系统代理是否已开（托盘勾选态与前端开关的真相源）。
    pub sys_proxy_enabled: Mutex<bool>,
    /// TUN 是否要求开启（内核可能尚未重启生效）。
    pub tun_enabled: Mutex<bool>,
    /// mihomo 混合端口，托盘直接切系统代理时要用。
    pub mixed_port: Mutex<u16>,
    /// 出站模式：rule / global / direct。
    pub mode: Mutex<String>,
    /// 菜单栏是否显示实时网速。
    pub show_tray_speed: Mutex<bool>,
    /// 关闭窗口后是否隐藏 Dock 图标（菜单栏保持常驻）。
    pub hide_dock_on_close: Mutex<bool>,
}

impl Default for AppFlags {
    fn default() -> Self {
        Self {
            close_to_tray: Mutex::new(false),
            sys_proxy_enabled: Mutex::new(false),
            tun_enabled: Mutex::new(false),
            mixed_port: Mutex::new(7890),
            mode: Mutex::new("rule".to_string()),
            show_tray_speed: Mutex::new(true),
            hide_dock_on_close: Mutex::new(true),
        }
    }
}

#[tauri::command]
pub fn set_close_to_tray(enabled: bool, app: tauri::AppHandle) {
    *app.state::<AppFlags>().close_to_tray.lock().unwrap() = enabled;
}

/// 开机自启（macOS LaunchAgent）。
///
/// 用当前可执行文件路径反推 .app 包位置，避免把绝对路径写死——
/// 用户拖到 /Applications 还是留在 Downloads，自启都能指对 app。
#[tauri::command]
pub fn set_launch_login(enable: bool) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|_| "读不到 HOME".to_string())?;
    let plist = PathBuf::from(&home).join("Library/LaunchAgents/com.ppclash.plist");

    if !enable {
        if plist.is_file() {
            std::fs::remove_file(&plist).map_err(|e| format!("移除自启项失败：{e}"))?;
        }
        return Ok(());
    }

    let exe = std::env::current_exe().map_err(|e| format!("读自身路径失败：{e}"))?;
    let app_bundle = exe
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .ok_or_else(|| "无法确定 app 路径".to_string())?;

    let xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.ppclash</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/open</string>
        <string>-a</string>
        <string>{}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
</dict>
</plist>
"#,
        app_bundle.display()
    );

    if let Some(parent) = plist.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建 LaunchAgents 目录失败：{e}"))?;
    }
    std::fs::write(&plist, xml).map_err(|e| format!("写入自启项失败：{e}"))?;
    Ok(())
}

/// 用系统默认浏览器打开外部链接；只允许 http(s)。
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("只支持 http(s) 链接".to_string());
    }
    std::process::Command::new("open")
        .arg(&url)
        .status()
        .map_err(|e| format!("打开链接失败：{e}"))?;
    Ok(())
}

/// 在 Finder 里打开数据目录，方便用户查看 config.yaml / 日志。
#[tauri::command]
pub fn open_data_dir(data_dir: String) -> Result<(), String> {
    let dir = resolve_data_dir(&data_dir)?;
    std::process::Command::new("open")
        .arg(&dir)
        .status()
        .map_err(|e| format!("打开目录失败：{e}"))?;
    Ok(())
}
