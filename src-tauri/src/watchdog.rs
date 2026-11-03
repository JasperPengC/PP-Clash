//! 网络清理看门狗。
//!
//! 只要应用进程退出（正常退出、崩溃、被 kill -9），看门狗都会：
//! - 关闭系统代理，避免系统继续指向已经死掉的本机端口
//! - 结束本应用数据目录对应的 mihomo，让 TUN 网卡随之消失
//!
//! 应用只是关窗到托盘时进程还活着，看门狗不会动手。

use std::path::PathBuf;

use tauri::AppHandle;

use crate::{platform, resources};

const MAC_SCRIPT: &str = r#"#!/bin/sh
APP_PID="$1"
DATA="$2"
PIDFILE="$DATA/watchdog.pid"
while kill -0 "$APP_PID" 2>/dev/null; do
  sleep 1
done
# 只在系统代理仍指向本应用端口时关闭，避免误伤其它客户端
PORT=$(cat "$DATA/watchdog.port" 2>/dev/null)
if [ -n "$PORT" ]; then
  /usr/sbin/networksetup -listallnetworkservices 2>/dev/null | tail -n +2 | sed 's/^\*//' | while IFS= read -r svc; do
    [ -n "$svc" ] || continue
    PROXY=$(/usr/sbin/networksetup -getwebproxy "$svc" 2>/dev/null)
    SERVER=$(printf '%s\n' "$PROXY" | awk -F': ' '/Server:/{print $2}')
    PPORT=$(printf '%s\n' "$PROXY" | awk -F': ' '/Port:/{print $2}')
    if [ "$SERVER" = "127.0.0.1" ] && [ "$PPORT" = "$PORT" ]; then
      /usr/sbin/networksetup -setwebproxystate "$svc" off >/dev/null 2>&1
      /usr/sbin/networksetup -setsecurewebproxystate "$svc" off >/dev/null 2>&1
    fi
  done
fi
# 结束本应用数据目录对应的内核（TUN 网卡会随进程退出）
/usr/bin/pkill -f "$DATA/config.yaml" 2>/dev/null
/usr/bin/pkill -f "$DATA/bin/mihomo" 2>/dev/null
rm -f "$PIDFILE"
"#;

const WIN_SCRIPT: &str = r#"param([int]$AppPid, [string]$DataDir)
while (Get-Process -Id $AppPid -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 1 }
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
Set-ItemProperty -Path $key -Name ProxyEnable -Value 0 -ErrorAction SilentlyContinue
$sig = @'
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);
}
'@
if ($ours) {
  try {
    Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue
    [W]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
  } catch {}
}
Get-CimInstance Win32_Process -Filter "Name='mihomo.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$DataDir*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item "$DataDir\watchdog.pid" -Force -ErrorAction SilentlyContinue
"#;

fn pid_file(data: &PathBuf) -> PathBuf {
    data.join("watchdog.pid")
}

fn stop_previous(data: &PathBuf) {
    let Ok(text) = std::fs::read_to_string(pid_file(data)) else {
        return;
    };
    let Ok(pid) = text.trim().parse::<u32>() else {
        return;
    };
    #[cfg(target_os = "windows")]
    {
        let _ = platform::command("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = platform::command("kill")
            .arg(pid.to_string())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    let _ = std::fs::remove_file(pid_file(data));
}

/// 更新看门狗清理时使用的代理端口。
pub fn set_port(port: u16) {
    if let Ok(data) = resources::data_dir() {
        let _ = std::fs::create_dir_all(&data);
        let _ = std::fs::write(data.join("watchdog.port"), port.to_string());
    }
}

/// 清掉端口标记：当前没有由本应用写入系统代理。
pub fn clear_port() {
    if let Ok(data) = resources::data_dir() {
        let _ = std::fs::remove_file(data.join("watchdog.port"));
    }
}

/// 以管理员身份重启前解除旧看门狗，避免它在新进程启动后误杀新内核。
pub fn stop_for_restart() {
    if let Ok(data) = resources::data_dir() {
        stop_previous(&data);
        let _ = std::fs::remove_file(data.join("watchdog.port"));
    }
}

/// 启动（或替换）当前进程的看门狗。失败只记录，不影响主流程。
pub fn start(app: &AppHandle) {
    let Ok(data) = resources::data_dir() else {
        return;
    };
    if std::fs::create_dir_all(&data).is_err() {
        return;
    }
    stop_previous(&data);

    #[cfg(target_os = "macos")]
    {
        let script = data.join("watchdog.sh");
        if std::fs::write(&script, MAC_SCRIPT).is_err() {
            return;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700));
        }
        let child = platform::command("/bin/sh")
            .arg(&script)
            .arg(std::process::id().to_string())
            .arg(&data)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
        if let Ok(child) = child {
            let _ = std::fs::write(pid_file(&data), child.id().to_string());
        }
    }

    #[cfg(target_os = "windows")]
    {
        let script = data.join("watchdog.ps1");
        if std::fs::write(&script, WIN_SCRIPT).is_err() {
            return;
        }
        let child = platform::command("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&script)
            .arg(std::process::id().to_string())
            .arg(&data)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
        if let Ok(child) = child {
            let _ = std::fs::write(pid_file(&data), child.id().to_string());
        }
    }
}
