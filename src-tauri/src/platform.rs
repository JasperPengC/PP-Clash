//! 平台差异集中在这里：数据目录、系统内核目录、可执行文件名。
//!
//! 其它模块只能通过本模块拿路径，避免把 `~/Library/Application Support`
//! 或 `/Library/...` 散落在业务代码里。

use std::path::PathBuf;

/// 各平台放应用数据的父目录。
pub fn base_data_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        std::env::var("HOME")
            .map(|h| PathBuf::from(h).join("Library/Application Support"))
            .map_err(|_| "读不到 HOME".to_string())
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var("APPDATA")
            .map(PathBuf::from)
            .map_err(|_| "读不到 APPDATA".to_string())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|_| {
                std::env::var("HOME")
                    .map(|h| PathBuf::from(h).join(".local/share"))
            })
            .map_err(|_| "读不到 HOME / XDG_DATA_HOME".to_string())
    }
}

/// 应用数据目录（保留旧目录名 PPClash，避免迁移）。
pub fn data_dir() -> Result<PathBuf, String> {
    Ok(base_data_dir()?.join("PPClash"))
}

/// 需要 root/admin 权限的系统内核目录。
pub fn system_bin_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        PathBuf::from("/Library/Application Support/PPClash/bin")
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var("PROGRAMDATA")
            .map(|p| PathBuf::from(p).join("PPClash/bin"))
            .unwrap_or_else(|_| PathBuf::from("C:\\ProgramData\\PPClash\\bin"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        PathBuf::from("/opt/ppclash/bin")
    }
}

pub fn kernel_binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "mihomo.exe"
    } else {
        "mihomo"
    }
}

/// 系统内核副本路径。
pub fn system_bin() -> PathBuf {
    system_bin_dir().join(kernel_binary_name())
}

/// 用户数据目录里的内核路径。
pub fn user_kernel_bin() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("bin").join(kernel_binary_name()))
}

/// 创建子进程命令；Windows 下隐藏控制台窗口，避免 reg/powershell/tasklist
/// 这类控制台程序每调用一次就弹一个黑框。
pub fn command<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// 异步子进程命令；Windows 下同样隐藏控制台窗口。
pub fn async_command<S: AsRef<std::ffi::OsStr>>(program: S) -> tokio::process::Command {
    #[allow(unused_mut)]
    let mut cmd = tokio::process::Command::new(program);
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Windows：用原生样式去掉标题栏，避免 Tauri set_decorations 未生效。
#[cfg(target_os = "windows")]
pub fn remove_native_caption(hwnd: isize) {
    use windows_sys::Win32::Graphics::Dwm::{DwmExtendFrameIntoClientArea, DwmSetWindowAttribute};
    use windows_sys::Win32::UI::Controls::MARGINS;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, SetWindowLongW, SetWindowPos, GWL_STYLE, SWP_FRAMECHANGED,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WS_BORDER, WS_CAPTION,
        WS_DLGFRAME, WS_THICKFRAME,
    };
    let hwnd = hwnd as *mut core::ffi::c_void;
    unsafe {
        let style = GetWindowLongW(hwnd, GWL_STYLE);
        // 去掉所有原生边框；阴影/圆角交给 DWM + CSS，避免 Windows 11
        // 在窗口四周再画一圈白色/浅色边框。
        let no_frame = (WS_CAPTION | WS_THICKFRAME | WS_BORDER | WS_DLGFRAME) as i32;
        SetWindowLongW(hwnd, GWL_STYLE, style & !no_frame);
        SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        );

        // Windows 11：保留圆角和 DWM 阴影，同时把原生白色/黑色边框颜色去掉。
        let corners: u32 = 2; // DWMWCP_ROUND
        let _ = DwmSetWindowAttribute(
            hwnd,
            33, // DWMWA_WINDOW_CORNER_PREFERENCE
            &corners as *const u32 as *const core::ffi::c_void,
            4,
        );
        let none: u32 = 0xFFFF_FFFE; // DWMWA_COLOR_NONE
        let _ = DwmSetWindowAttribute(
            hwnd,
            34, // DWMWA_BORDER_COLOR
            &none as *const u32 as *const core::ffi::c_void,
            4,
        );
        let margins = MARGINS { cxLeftWidth: 1, cxRightWidth: 1, cyTopHeight: 1, cyBottomHeight: 1 };
        let _ = DwmExtendFrameIntoClientArea(hwnd, &margins);
    }
}

/// 当前进程是否以管理员权限运行（Windows）；其它平台视为 true。
pub fn is_elevated() -> bool {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        use windows_sys::Win32::Security::{
            GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
        };
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return false;
            }
            let mut elevation: TOKEN_ELEVATION = std::mem::zeroed();
            let mut len = 0u32;
            let ok = GetTokenInformation(
                token,
                TokenElevation,
                &mut elevation as *mut TOKEN_ELEVATION as *mut core::ffi::c_void,
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut len,
            );
            let _ = CloseHandle(token);
            ok != 0 && elevation.TokenIsElevated != 0
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        true
    }
}
