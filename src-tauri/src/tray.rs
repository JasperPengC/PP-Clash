//! 托盘：状态图标 + 两行实时速率图标 + 自制快捷面板。
//!
//! 菜单栏不显示文字标题，避免宽度抖动；速率绘制成模板图标（两行、固定字宽）。
//! 面板是独立的透明 WebView 窗口，由前端 TrayPanel 渲染。

use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use serde::Serialize;
use serde_json::Value;
use tauri::image::Image;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Position, Size, WebviewUrl, WebviewWindowBuilder};
use tauri::tray::TrayIconEvent;

use crate::kernel::KernelState;
use crate::mihomo;
use crate::prefs::AppFlags;

const ICON_OFF_DARK: &[u8] = include_bytes!("../resources/tray/off-dark.png");
const ICON_OFF_LIGHT: &[u8] = include_bytes!("../resources/tray/off-light.png");
const ICON_PROXY_DARK: &[u8] = include_bytes!("../resources/tray/proxy-dark.png");
const ICON_PROXY_LIGHT: &[u8] = include_bytes!("../resources/tray/proxy-light.png");
const ICON_TUN_DARK: &[u8] = include_bytes!("../resources/tray/tun-dark.png");
const ICON_TUN_LIGHT: &[u8] = include_bytes!("../resources/tray/tun-light.png");
const GLYPHS: &[u8] = include_bytes!("../resources/tray/glyphs.raw");
const SPEED_CHARS: &str = "0123456789.KMGB↑↓ ";
const GLYPH_W: usize = 12;
const GLYPH_H: usize = 22;
const SPEED_W: usize = GLYPH_W * 6;
const SPEED_H: usize = GLYPH_H * 2;

static SPEED_STATE: OnceLock<Mutex<Option<(u64, u64, Instant)>>> = OnceLock::new();
static LAST_RATES: OnceLock<Mutex<(f64, f64)>> = OnceLock::new();
static LAST_SPEED_LABEL: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static PANEL_HIDDEN_AT: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();

fn speed_state() -> &'static Mutex<Option<(u64, u64, Instant)>> {
    SPEED_STATE.get_or_init(|| Mutex::new(None))
}

fn last_rates() -> &'static Mutex<(f64, f64)> {
    LAST_RATES.get_or_init(|| Mutex::new((0.0, 0.0)))
}

fn last_speed_label() -> &'static Mutex<Option<String>> {
    LAST_SPEED_LABEL.get_or_init(|| Mutex::new(None))
}

fn panel_hidden_at() -> &'static Mutex<Option<Instant>> {
    PANEL_HIDDEN_AT.get_or_init(|| Mutex::new(None))
}

fn base(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

pub fn create_panel(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("tray-panel").is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(
        app,
        "tray-panel",
        WebviewUrl::App("index.html?panel=tray".into()),
    )
    .title("PP Clash")
    .inner_size(320.0, 500.0)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 托盘点击：在托盘图标下方弹出 / 收起快捷面板。
pub fn toggle_panel(app: &AppHandle, rect: tauri::Rect) {
    // 首次打开时才创建面板 WebView，避免常驻多一个渲染进程
    if app.get_webview_window("tray-panel").is_none() {
        if let Err(e) = create_panel(app) {
            eprintln!("[tray] 创建面板失败：{e}");
            return;
        }
    }
    let Some(panel) = app.get_webview_window("tray-panel") else {
        return;
    };
    if panel.is_visible().unwrap_or(false) {
        hide_panel(app);
        return;
    }
    // 刚因失焦收起时，同一次托盘点击不再立刻弹出
    if let Ok(guard) = panel_hidden_at().lock() {
        if let Some(at) = *guard {
            if at.elapsed().as_millis() < 250 {
                return;
            }
        }
    }

    let monitor = app
        .get_webview_window("main")
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let scale = monitor.as_ref().map(|m| m.scale_factor()).unwrap_or(2.0);
    let screen_w = monitor
        .as_ref()
        .map(|m| m.size().width as f64)
        .unwrap_or(6016.0);

    let (rx, ry, rw, rh) = match (rect.position, rect.size) {
        (Position::Physical(p), Size::Physical(s)) => {
            (p.x as f64, p.y as f64, s.width as f64, s.height as f64)
        }
        (Position::Logical(p), Size::Logical(s)) => (
            p.x * scale,
            p.y * scale,
            s.width * scale,
            s.height * scale,
        ),
        _ => (0.0, 0.0, 0.0, 0.0),
    };

    let panel_w = 320.0 * scale;
    let panel_h = 500.0 * scale;
    let x = (rx + rw / 2.0 - panel_w / 2.0).clamp(8.0, (screen_w - panel_w - 8.0).max(8.0));
    let y = {
        #[cfg(target_os = "windows")]
        {
            // Windows 任务栏通常在底部，托盘图标位于工作区下方；面板应向上展开。
            let work = monitor.as_ref().map(|m| m.work_area().clone());
            let above = work
                .as_ref()
                .map(|w| {
                    (ry + rh * 0.5) >= (w.position.y as f64 + w.size.height as f64 / 2.0)
                })
                .unwrap_or(ry > screen_w * 0.0 + 900.0);
            if above {
                (ry - panel_h - 8.0 * scale).max(8.0)
            } else {
                ry + rh + 8.0 * scale
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            ry + rh + 8.0 * scale
        }
    };
    let _ = panel.set_position(PhysicalPosition::new(x, y));
    let _ = panel.show();
    let _ = panel.set_focus();
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayNode {
    pub name: String,
    pub delay: Option<u32>,
    pub selected: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayProfile {
    pub id: String,
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraySnapshot {
    pub running: bool,
    pub sys_proxy: bool,
    pub tun: bool,
    pub mode: String,
    pub node: Option<String>,
    pub group: Option<String>,
    pub up: f64,
    pub down: f64,
    pub show_speed: bool,
    #[serde(rename = "controllerPort")]
    pub controller_port: u16,
    pub nodes: Vec<TrayNode>,
    pub profiles: Vec<TrayProfile>,
    pub active_profile: Option<String>,
}

async fn fetch_group_info(port: u16) -> Option<(String, String, Vec<TrayNode>)> {
    let raw = mihomo::request(&base(port), "", "GET", "/proxies", None)
        .await
        .ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let proxies = v.get("proxies")?.as_object()?;
    let group_types = ["Selector", "URLTest", "Fallback", "LoadBalance", "Relay"];

    for (group_name, info) in proxies {
        if group_name == "GLOBAL" {
            continue;
        }
        if info.get("type").and_then(|x| x.as_str()) != Some("Selector") {
            continue;
        }
        let now = info.get("now").and_then(|x| x.as_str())?.to_string();

        // 沿 now 一直解析到真正的叶子节点（例如 一毛机场 -> 自动选择 -> 美国圣何塞02）
        let mut actual = now.clone();
        for _ in 0..8 {
            let Some(info) = proxies.get(&actual) else { break };
            if !group_types.contains(&info.get("type").and_then(|x| x.as_str()).unwrap_or("")) {
                break;
            }
            let Some(next) = info.get("now").and_then(|x| x.as_str()) else { break };
            if next == actual {
                break;
            }
            actual = next.to_string();
        }

        let all: Vec<String> = info
            .get("all")
            .and_then(|x| x.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default();

        let mut nodes: Vec<TrayNode> = all
            .into_iter()
            .filter(|name| {
                if matches!(name.as_str(), "DIRECT" | "REJECT" | "REJECT-DROP") {
                    return false;
                }
                let kind = proxies
                    .get(name)
                    .and_then(|p| p.get("type"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("");
                !group_types.contains(&kind)
            })
            .map(|name| TrayNode {
                delay: proxies
                    .get(&name)
                    .and_then(|p| p.get("history"))
                    .and_then(|h| h.as_array())
                    .and_then(|h| h.last())
                    .and_then(|last| last.get("delay"))
                    .and_then(|d| d.as_u64())
                    .filter(|d| *d > 0)
                    .map(|d| d as u32),
                selected: name == actual,
                name,
            })
            .collect();

        // 自动选择的分组节点不一定出现在父分组 all 里，兜底补上当前实际节点
        if !nodes.iter().any(|n| n.name == actual) {
            nodes.push(TrayNode {
                name: actual.clone(),
                delay: None,
                selected: true,
            });
        }
        nodes.sort_by(|a, b| {
            if a.selected != b.selected {
                return if a.selected {
                    std::cmp::Ordering::Less
                } else {
                    std::cmp::Ordering::Greater
                };
            }
            let da = a.delay.unwrap_or(u32::MAX);
            let db = b.delay.unwrap_or(u32::MAX);
            da.cmp(&db).then_with(|| a.name.cmp(&b.name))
        });
        return Some((group_name.clone(), actual, nodes));
    }
    None
}

/// 把速率画成两行模板图标：固定 6 字符/行，宽度不变。
fn speed_body(bps: f64) -> String {
    let s = if bps >= 1_000_000_000.0 {
        format!("{:.1}G", bps / 1_000_000_000.0)
    } else if bps >= 1_000_000.0 {
        format!("{:.1}M", bps / 1_000_000.0)
    } else if bps >= 1_000.0 {
        format!("{:.0}K", bps / 1_000.0)
    } else {
        format!("{:.0}B", bps)
    };
    format!("{s:>5}")
}

fn render_speed_icon(up: f64, down: f64, color: [u8; 3]) -> Result<Image<'static>, String> {
    let lines = [format!("↑{}", speed_body(up)), format!("↓{}", speed_body(down))];
    let mut rgba = vec![0u8; SPEED_W * SPEED_H * 4];
    for (line_idx, line) in lines.iter().enumerate() {
        for (char_idx, ch) in line.chars().enumerate() {
            let glyph = SPEED_CHARS
                .chars()
                .position(|c| c == ch)
                .unwrap_or(SPEED_CHARS.chars().count() - 1);
            for gy in 0..GLYPH_H {
                for gx in 0..GLYPH_W {
                    let src = ((gy * GLYPH_W * SPEED_CHARS.chars().count())
                        + glyph * GLYPH_W
                        + gx)
                        * 4;
                    let dst = (((line_idx * GLYPH_H + gy) * SPEED_W) + char_idx * GLYPH_W + gx)
                        * 4;
                    let alpha = GLYPHS[src + 3];
                    rgba[dst] = color[0];
                    rgba[dst + 1] = color[1];
                    rgba[dst + 2] = color[2];
                    rgba[dst + 3] = alpha;
                }
            }
        }
    }
    Ok(Image::new_owned(rgba, SPEED_W as u32, SPEED_H as u32))
}

fn render_status_icon(
    state: u8,
    up: f64,
    down: f64,
    show_speed: bool,
    dark: bool,
) -> Result<Image<'static>, String> {
    let bytes = match (state, dark) {
        (2, true) => ICON_TUN_DARK,
        (2, false) => ICON_TUN_LIGHT,
        (1, true) => ICON_PROXY_DARK,
        (1, false) => ICON_PROXY_LIGHT,
        (_, true) => ICON_OFF_DARK,
        (_, false) => ICON_OFF_LIGHT,
    };
    let state_img = Image::from_bytes(bytes).map_err(|e| e.to_string())?;
    if !show_speed {
        return Ok(state_img);
    }
    let speed = render_speed_icon(up, down, if dark { [255, 255, 255] } else { [0, 0, 0] })?;
    let state_w = state_img.width() as usize;
    let state_h = state_img.height() as usize;
    let speed_w = speed.width() as usize;
    let speed_h = speed.height() as usize;
    let width = state_w + speed_w;
    let height = state_h.max(speed_h);
    let mut rgba = vec![0u8; width * height * 4];
    // 状态图标贴左侧
    for y in 0..state_h {
        for x in 0..state_w {
            let src = (y * state_w + x) * 4;
            let dst = (y * width + x) * 4;
            rgba[dst..dst + 4].copy_from_slice(&state_img.rgba()[src..src + 4]);
        }
    }
    // 两行速率贴右侧，垂直居中
    let offset_y = (height - speed_h) / 2;
    for y in 0..speed_h {
        for x in 0..speed_w {
            let src = (y * speed_w + x) * 4;
            let dst = ((y + offset_y) * width + state_w + x) * 4;
            rgba[dst..dst + 4].copy_from_slice(&speed.rgba()[src..src + 4]);
        }
    }
    Ok(Image::new_owned(rgba, width as u32, height as u32))
}

async fn speed_rates(app: &AppHandle) -> Option<(f64, f64)> {
    let port = *app.state::<KernelState>().controller_port.lock().await;
    let raw = mihomo::request(&base(port), "", "GET", "/connections", None)
        .await
        .ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let up = v
        .get("uploadTotal")
        .or_else(|| v.get("uploadTraffic"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0);
    let down = v
        .get("downloadTotal")
        .or_else(|| v.get("downloadTraffic"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0);

    let now = Instant::now();
    let mut guard = speed_state().lock().ok()?;
    let rates = if let Some((last_up, last_down, last_at)) = *guard {
        let dt = now.duration_since(last_at).as_secs_f64().max(0.2);
        (
            up.saturating_sub(last_up) as f64 / dt,
            down.saturating_sub(last_down) as f64 / dt,
        )
    } else {
        (0.0, 0.0)
    };
    *guard = Some((up, down, now));
    if let Ok(mut cache) = last_rates().lock() {
        *cache = rates;
    }
    Some(rates)
}

fn read_flags(app: &AppHandle) -> (bool, bool, bool, String) {
    let flags = app.state::<AppFlags>();
    let sys = *flags.sys_proxy_enabled.lock().unwrap();
    let tun = *flags.tun_enabled.lock().unwrap();
    let show = *flags.show_tray_speed.lock().unwrap();
    let mode = flags.mode.lock().unwrap().clone();
    (sys, tun, show, mode)
}

/// 读取菜单栏按钮的真实 effectiveAppearance。
/// 系统是浅色但菜单栏被深色壁纸/强调色染暗时，不能只看系统主题。
#[cfg(target_os = "macos")]
fn menu_bar_is_dark(app: &AppHandle) -> bool {
    let Some(tray) = app.tray_by_id("main") else {
        return true;
    };
    tray.with_inner_tray_icon(|inner| {
        use objc2::MainThreadMarker;
        use objc2_app_kit::NSAppearanceCustomization;
        let Some(mtm) = MainThreadMarker::new() else {
            return None;
        };
        let item = inner.ns_status_item()?;
        let button = item.button(mtm)?;
        let name = button.effectiveAppearance().name().to_string();
        Some(name.contains("Dark"))
    })
    .ok()
    .flatten()
    .unwrap_or(true)
}

#[cfg(not(target_os = "macos"))]
fn menu_bar_is_dark(_app: &AppHandle) -> bool {
    false
}

/// 更新菜单栏图标（状态 + 两行速率合成在一张图里）。
pub async fn update_indicator(app: &AppHandle) -> Result<(), String> {
    let (sys_proxy, tun, show_speed, _) = read_flags(app);
    let state = if tun { 2 } else if sys_proxy { 1 } else { 0 };
    let dark = menu_bar_is_dark(app);

    let running = crate::kernel::is_running(app).await;
    let rates = if running {
        speed_rates(app).await.unwrap_or((0.0, 0.0))
    } else {
        (0.0, 0.0)
    };

    #[cfg(target_os = "windows")]
    {
        // Windows 通知区域只有 16/32px，不适合把两行速率画进图标；
        // 状态用图标表示，速率放 tooltip，交互走原生右键菜单。
        let bytes = match state {
            2 => ICON_TUN_DARK,
            1 => ICON_PROXY_DARK,
            _ => ICON_OFF_DARK,
        };
        let image = Image::from_bytes(bytes).map_err(|e| e.to_string())?;
        if let Some(tray) = app.tray_by_id("main") {
            tray.set_icon_with_as_template(Some(image), false)
                .map_err(|e| e.to_string())?;
            let label = if tun {
                "TUN"
            } else if sys_proxy {
                "系统代理"
            } else {
                "未接管"
            };
            let tip = if show_speed && running {
                format!(
                    "PP Clash · {label} · ↑{}/s ↓{}/s",
                    speed_body(rates.0),
                    speed_body(rates.1)
                )
            } else {
                format!("PP Clash · {label}")
            };
            let _ = tray.set_tooltip(Some(tip));
        }
        return Ok(());
    }

    let label = format!(
        "{}|{}|{}|{}|{}",
        state,
        show_speed,
        dark,
        speed_body(rates.0),
        speed_body(rates.1)
    );
    let last = last_speed_label().lock().map_err(|e| e.to_string())?;
    let changed = last.as_deref() != Some(label.as_str());
    drop(last);

    if changed {
        if let Some(tray) = app.tray_by_id("main") {
            let image = render_status_icon(state, rates.0, rates.1, show_speed, dark)?;
            tray.set_icon_with_as_template(Some(image), false)
                .map_err(|e| e.to_string())?;
            let _ = tray.set_title(None::<&str>);
        }
        if let Ok(mut last) = last_speed_label().lock() {
            *last = Some(label);
        }
    }

    if !running {
        if let Ok(mut s) = speed_state().lock() {
            *s = None;
        }
        if let Ok(mut c) = last_rates().lock() {
            *c = (0.0, 0.0);
        }
    }
    Ok(())
}

/// 兼容旧调用：只刷新状态，不再构建原生菜单。
pub async fn rebuild(app: &AppHandle) -> Result<(), String> {
    update_indicator(app).await
}

/// 1s 心跳：图标 / 速率。
pub async fn tick(app: &AppHandle) -> Result<(), String> {
    update_indicator(app).await
}

#[tauri::command]
pub async fn sync_tray(app: AppHandle) -> Result<(), String> {
    update_indicator(&app).await
}

#[tauri::command]
pub async fn set_tray_flags(
    app: AppHandle,
    tun_enabled: bool,
    sys_proxy_enabled: bool,
    mixed_port: u16,
    mode: String,
    show_speed: bool,
    hide_dock: bool,
) -> Result<(), String> {
    if sys_proxy_enabled {
        crate::watchdog::set_port(mixed_port);
    } else {
        crate::watchdog::clear_port();
    }
    {
        let flags = app.state::<AppFlags>();
        *flags.tun_enabled.lock().unwrap() = tun_enabled;
        *flags.sys_proxy_enabled.lock().unwrap() = sys_proxy_enabled;
        *flags.mixed_port.lock().unwrap() = mixed_port;
        *flags.mode.lock().unwrap() = mode;
        *flags.show_tray_speed.lock().unwrap() = show_speed;
        *flags.hide_dock_on_close.lock().unwrap() = hide_dock;
    }
    update_indicator(&app).await
}

fn load_profiles() -> (Vec<TrayProfile>, Option<String>) {
    let path = crate::resources::data_dir()
        .map(|d| d.join("state.json"))
        .ok();
    let Some(path) = path else {
        return (Vec::new(), None);
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return (Vec::new(), None);
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return (Vec::new(), None);
    };
    let active = v
        .get("activeId")
        .and_then(|x| x.as_str())
        .map(String::from);
    let profiles = v
        .get("profiles")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| {
                    Some(TrayProfile {
                        id: p.get("id")?.as_str()?.to_string(),
                        name: p.get("name")?.as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    (profiles, active)
}

#[tauri::command]
pub async fn tray_snapshot(app: AppHandle) -> Result<TraySnapshot, String> {
    let (sys_proxy, tun, show_speed, mode) = read_flags(&app);
    let running = crate::kernel::is_running(&app).await;
    let port = *app.state::<KernelState>().controller_port.lock().await;
    let group_info = if running {
        fetch_group_info(port).await
    } else {
        None
    };
    let (node, group, nodes) = match group_info {
        Some((group, node, nodes)) => (Some(node), Some(group), nodes),
        None => (None, None, Vec::new()),
    };
    let (up, down) = *last_rates().lock().map_err(|e| e.to_string())?;
    let (profiles, active_profile) = load_profiles();
    Ok(TraySnapshot {
        running,
        sys_proxy,
        tun,
        mode,
        node,
        group,
        up,
        down,
        show_speed,
        nodes,
        profiles,
        active_profile,
        controller_port: port,
    })
}

#[tauri::command]
pub async fn tray_action(
    app: AppHandle,
    action: String,
    value: Option<String>,
) -> Result<(), String> {
    match action.as_str() {
        "restart" => {
            app.restart();
        }
        "close" => {
            if let Some(panel) = app.get_webview_window("tray-panel") {
                let _ = panel.hide();
            }
        }
        "quit" => {
            // 退出前先恢复网络：否则系统代理/TUN 会指向已退出的内核。
            let flags = app.state::<AppFlags>();
            let sys = *flags.sys_proxy_enabled.lock().unwrap();
            let port = *flags.mixed_port.lock().unwrap();
            drop(flags);
            if sys {
                let _ = crate::sysproxy::set_system_proxy(false, "127.0.0.1".to_string(), port);
            }
            let _ = crate::kernel::stop_kernel(app.clone()).await;
            app.exit(0);
        }
        "sysproxy" => {
            let enable = value.as_deref() == Some("true");
            let _ = app.emit("tray://panel-sysproxy", enable);
        }
        "tun" => {
            let _ = app.emit("tray://tun", ());
        }
        "mode" => {
            let Some(mode) = value else {
                return Ok(());
            };
            *app.state::<AppFlags>().mode.lock().unwrap() = mode.clone();
            let _ = app.emit("tray://mode", mode);
        }
        "profile" => {
            if let Some(id) = value {
                let _ = app.emit("tray://panel-profile", id);
            }
        }
        "node" => {
            if let Some(value) = value {
                if let Some((group, node)) = value.split_once('|') {
                    let _ = app.emit(
                        "tray://panel-node",
                        serde_json::json!({ "group": group, "node": node }),
                    );
                }
            }
        }
        "open" => {
            crate::focus_main(&app);
            let _ = app.emit("tray://navigate", value.unwrap_or_else(|| "overview".to_string()));
            if let Some(panel) = app.get_webview_window("tray-panel") {
                let _ = panel.hide();
            }
        }
        _ => {}
    }
    Ok(())
}

/// 兼容旧托盘菜单：现在不建原生菜单，只保留空实现避免误用。
#[allow(dead_code)]
pub fn handle_menu_event(_app: &AppHandle, event: tauri::menu::MenuEvent) {
    let _ = event.id().as_ref();
}

/// 面板失焦时收起（由 lib 的窗口事件调用）。
pub fn hide_panel(app: &AppHandle) {
    if let Some(panel) = app.get_webview_window("tray-panel") {
        let _ = panel.hide();
    }
    if let Ok(mut at) = panel_hidden_at().lock() {
        *at = Some(Instant::now());
    }
}

/// 托盘图标点击入口。
pub fn on_tray_click(app: &AppHandle, event: TrayIconEvent) {
    if let TrayIconEvent::Click {
        rect,
        button,
        button_state: tauri::tray::MouseButtonState::Up,
        ..
    } = event
    {
        #[cfg(target_os = "windows")]
        if button != tauri::tray::MouseButton::Left && button != tauri::tray::MouseButton::Right {
            return;
        }
        #[cfg(not(target_os = "windows"))]
        if button != tauri::tray::MouseButton::Left {
            return;
        }
        toggle_panel(app, rect);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speed_icon_has_pixels() {
        let img = render_speed_icon(12_300.0, 456_000.0, [0, 0, 0]).unwrap();
        assert_eq!((img.width(), img.height()), (SPEED_W as u32, SPEED_H as u32));
        let opaque = img.rgba().chunks(4).filter(|p| p[3] > 0).count();
        assert!(opaque > 50, "speed icon should not be empty, opaque={opaque}");
        std::fs::write("/tmp/speed-icon.raw", img.rgba()).unwrap();
    }
}
