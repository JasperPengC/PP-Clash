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
