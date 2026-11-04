#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "windows")]
fn windows_preflight() -> bool {
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::System::Threading::CreateMutexW;

    let name: Vec<u16> = "Local\\PPClashInstance\0".encode_utf16().collect();
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr() as *const u16) };
    if !handle.is_null() && unsafe { GetLastError() } == 183 {
        // 已有实例在运行：让出，避免第二个 WebView2 抢同一个用户数据目录。
        return false;
    }

    // 只有上一次没有正常退出时才清理 WebView2 缓存，避免每次冷启动都重建缓存。
    let app_data = std::env::var("APPDATA")
        .map(|p| std::path::PathBuf::from(p).join("PPClash"))
        .ok();
    if let Some(data) = &app_data {
        let flag = data.join("running.flag");
        if flag.exists() {
            if let Ok(local) = std::env::var("LOCALAPPDATA") {
                let dir = std::path::PathBuf::from(local)
                    .join("com.ppclash.app")
                    .join("EBWebView");
                let _ = std::fs::remove_dir_all(dir);
            }
            let _ = std::fs::remove_file(&flag);
        }
        let _ = std::fs::create_dir_all(data);
        let _ = std::fs::write(flag, std::process::id().to_string());
    }
    let _ = handle;
    true
}


#[cfg(not(target_os = "windows"))]
fn unix_preflight() -> bool {
    use std::process::{Command, Stdio};

    let data = if cfg!(target_os = "macos") {
        std::env::var("HOME")
            .map(|h| std::path::PathBuf::from(h).join("Library/Application Support/PPClash"))
            .ok()
    } else {
        std::env::var("XDG_DATA_HOME")
            .ok()
            .map(std::path::PathBuf::from)
            .or_else(|| std::env::var("HOME").ok().map(|h| std::path::PathBuf::from(h).join(".local/share")))
            .map(|p| p.join("PPClash"))
    };
    let Some(data) = data else { return true };
    let _ = std::fs::create_dir_all(&data);
    let lock = data.join("instance.lock");
    if let Ok(text) = std::fs::read_to_string(&lock) {
        if let Ok(pid) = text.trim().parse::<u32>() {
            let alive = Command::new("/bin/kill")
                .args(["-0", &pid.to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if alive {
                return false;
            }
        }
    }
    let _ = std::fs::write(lock, std::process::id().to_string());
    true
}


#[cfg(target_os = "windows")]
fn instance_running() -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::OpenMutexW;

    let name: Vec<u16> = "Local\\PPClashInstance\0".encode_utf16().collect();
    let handle = unsafe { OpenMutexW(0x0010_0000, 0, name.as_ptr() as *const u16) };
    if handle.is_null() {
        false
    } else {
        unsafe { let _ = CloseHandle(handle); }
        true
    }
}

/// Windows 默认以管理员模式启动：非提权进程先拉起 UAC，再退出自己。
/// 返回 true 表示“已经在本进程继续”，false 表示应直接退出。
#[cfg(target_os = "windows")]
fn ensure_elevated() -> bool {
    use std::os::windows::process::CommandExt;

    if ppclash_lib::is_elevated() {
        return true;
    }
    if instance_running() {
        return false;
    }
    let Ok(exe) = std::env::current_exe() else {
        return true;
    };
    let ps = format!(
        "Start-Process -FilePath '{}' -Verb RunAs",
        exe.display()
    );
    let status = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &ps,
        ])
        .creation_flags(0x0800_0000)
        .status();
    match status {
        Ok(s) if s.success() => false,
        _ => true, // UAC 被取消时回退普通模式，至少让应用能打开
    }
}

fn main() {
    #[cfg(target_os = "windows")]
    {
        if !ensure_elevated() {
            return;
        }
        if !windows_preflight() {
            return;
        }
    }
    #[cfg(not(target_os = "windows"))]
    if !unix_preflight() {
        return;
    }
    ppclash_lib::run();
}
