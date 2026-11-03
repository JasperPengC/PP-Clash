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

fn main() {
    #[cfg(target_os = "windows")]
    if !windows_preflight() {
        return;
    }
    ppclash_lib::run();
}
