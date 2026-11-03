//! 进程图标：从 macOS .app 包里提取 64px PNG，返回 data URL 供前端使用。

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::resources;

fn data_dir() -> Result<PathBuf, String> {
    resources::data_dir()
}

fn find_bundle(exec_path: &Path) -> Option<PathBuf> {
    let text = exec_path.display().to_string();
    let idx = text.find(".app/")?;
    let bundle = PathBuf::from(&text[..idx + 4]);
    bundle.is_dir().then_some(bundle)
}

fn icon_from_info_plist(app: &Path) -> Option<PathBuf> {
    let plist = app.join("Contents/Info.plist");
    let out = Command::new("plutil")
        .args(["-extract", "CFBundleIconFile", "raw", "-o", "-"])
        .arg(&plist)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if name.is_empty() {
        return None;
    }
    let file = if name.ends_with(".icns") {
        name
    } else {
        format!("{name}.icns")
    };
    let path = app.join("Contents/Resources").join(file);
    path.is_file().then_some(path)
}

fn first_icns(app: &Path) -> Option<PathBuf> {
    let dir = app.join("Contents/Resources");
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.extension().and_then(|s| s.to_str()) == Some("icns"))
}

fn extract_png(app: &Path, dest: &Path) -> Result<(), String> {
    let icns = icon_from_info_plist(app)
        .or_else(|| first_icns(app))
        .ok_or_else(|| "找不到图标文件".to_string())?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let status = Command::new("sips")
        .args(["-s", "format", "png", "-Z", "64"])
        .arg(&icns)
        .arg("--out")
        .arg(dest)
        .output()
        .map_err(|e| format!("sips 执行失败：{e}"))?;
    if !status.status.success() || !dest.is_file() {
        return Err("图标转换失败".to_string());
    }
    Ok(())
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// 根据进程可执行路径找到 .app，提取图标并返回 data URL；找不到时返回 None。
#[tauri::command]
pub async fn resolve_process_icon(process_path: String) -> Result<Option<String>, String> {
    let exec = PathBuf::from(process_path);
    let Some(app) = find_bundle(&exec) else {
        return Ok(None);
    };

    // 用路径哈希做磁盘缓存
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    app.hash(&mut hasher);
    let cache = data_dir()?.join("icons").join(format!("{:x}.png", hasher.finish()));

    if !cache.is_file() {
        if extract_png(&app, &cache).is_err() {
            return Ok(None);
        }
    }

    let bytes = std::fs::read(cache).map_err(|e| e.to_string())?;
    Ok(Some(format!("data:image/png;base64,{}", base64(&bytes))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_app_bundle() {
        let path = PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
        assert_eq!(
            find_bundle(&path).map(|p| p.display().to_string()),
            Some("/Applications/Google Chrome.app".to_string())
        );
    }
}
