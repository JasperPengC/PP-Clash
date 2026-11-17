//! 托盘：状态图标 + 两行实时速率图标 + 自制快捷面板。
//!
//! 菜单栏使用同源猫头和状态眼睛；速率合成两行固定宽图，外观读取状态栏按钮。
//! 面板是独立的透明 WebView 窗口，由前端 TrayPanel 渲染。

use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::image::Image;
use tauri::{AppHandle, Emitter, Listener, Manager, PhysicalPosition, Position, Size, WebviewUrl, WebviewWindowBuilder};
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
#[cfg(test)]
const ICON_TEMPLATE: &[u8] = include_bytes!("../icons/tray_icon.png");
const GLYPHS: &[u8] = include_bytes!("../resources/tray/glyphs.raw");
const SPEED_CHARS: &str = "0123456789.KMGB↑↓ ";
const GLYPH_W: usize = 12;
const GLYPH_H: usize = 22;
const SPEED_COLUMNS: usize = 6;
const SPEED_W: usize = 84; // 固定画布宽度；tray-icon 按 18pt 总高度等比显示。
const SPEED_H: usize = GLYPH_H * 2;
// 340×520 内容卡片，四周留出 CSS 阴影空间（上 12 / 横向 20 / 下 28）。
const PANEL_WIDTH: f64 = 380.0;
const PANEL_HEIGHT: f64 = 560.0;
const PANEL_TOP_INSET: f64 = 12.0;
const PANEL_BOTTOM_INSET: f64 = 28.0;

static LAST_SPEED_LABEL: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static PANEL_HIDDEN_AT: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
// 主窗口在解析配置后同步顺序；快照不再读取或解析订阅。
static TRAY_GROUP_ORDER: OnceLock<Mutex<Vec<String>>> = OnceLock::new();

fn tray_group_order() -> &'static Mutex<Vec<String>> {
    TRAY_GROUP_ORDER.get_or_init(|| Mutex::new(Vec::new()))
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
    .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
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

/// Linux AppIndicator 不提供图标点击坐标，通过兼容菜单在工作区右上角打开面板。
#[cfg(target_os = "linux")]
pub fn open_panel_from_menu(app: &AppHandle) {
    if let Err(e) = create_panel(app) { eprintln!("[tray] 创建面板失败：{e}"); return; }
    if let Some(panel) = app.get_webview_window("tray-panel") {
        if let Some(monitor) = app.get_webview_window("main").and_then(|w|w.current_monitor().ok().flatten())
            .or_else(||app.primary_monitor().ok().flatten()) {
            let area = monitor.work_area();
            let x = area.position.x as f64 + (area.size.width as f64 - PANEL_WIDTH * monitor.scale_factor() - 8.0).max(0.0);
            let y = area.position.y as f64 + 8.0;
            let _ = panel.set_position(PhysicalPosition::new(x,y));
        }
        let _ = panel.show();
        let _ = panel.set_focus();
    }
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

    let panel_w = PANEL_WIDTH * scale;
    let panel_h = PANEL_HEIGHT * scale;
    #[cfg(not(target_os = "windows"))]
    let _ = (panel_h, PANEL_BOTTOM_INSET);
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
                (ry - panel_h + (PANEL_BOTTOM_INSET - 8.0) * scale).max(8.0)
            } else {
                ry + rh + (8.0 - PANEL_TOP_INSET) * scale
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            ry + rh + (8.0 - PANEL_TOP_INSET) * scale
        }
    };
    let _ = panel.set_position(PhysicalPosition::new(x, y));
    let _ = panel.show();
    let _ = panel.set_focus();
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayNode {
    pub name: String,
    pub delay: Option<u32>,
    pub selected: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayGroup {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub now: Option<String>,
    pub manual: bool,
    pub total: usize,
    pub nodes: Vec<TrayNode>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayProfile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub userinfo: Option<TrayQuota>,
    #[serde(default)]
    pub updated_at: Option<f64>,
    #[serde(default)]
    pub source_type: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct TrayQuota {
    pub upload: f64,
    pub download: f64,
    pub total: f64,
    pub expire: f64,
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
    #[serde(rename = "controllerSecret")]
    pub controller_secret: String,
    pub nodes: Vec<TrayNode>,
    pub groups: Vec<TrayGroup>,
    pub groups_error: Option<String>,
    pub profiles: Vec<TrayProfile>,
    pub active_profile: Option<String>,
}

async fn fetch_groups(port: u16, secret: &str, order: &[String]) -> Result<Vec<TrayGroup>, String> {
    let raw = mihomo::request(&base(port), secret, "GET", "/proxies", None)
        .await
        .map_err(|_| "策略读取失败，等待下次刷新".to_string())?;
    let v: Value = serde_json::from_str(&raw).map_err(|_| "策略响应无法读取".to_string())?;
    if !v.get("proxies").is_some_and(Value::is_object) {
        return Err("策略响应缺少节点列表".to_string());
    }
    Ok(group_summaries(&v, order))
}

fn group_latency_target(group: &str) -> &'static str {
    // 与前端 isStableEgressName 一致，只给 GitHub/开发分组使用独立目标。
    let lower = group.to_lowercase();
    if lower.match_indices("git").any(|(index, _)| lower[index + 3..].trim_start().starts_with("hub"))
        || ["代码", "开发", "程序", "固定出口"].iter().any(|name| group.contains(name))
    {
        "https://github.com/robots.txt"
    } else {
        "https://www.google.com/generate_204"
    }
}

fn target_latency(proxy: &Value, target: &str) -> Option<u32> {
    // 通用 history 不含目标来源，不能用于当前分组的延迟。
    let state = proxy.get("extra")?.get(target)?;
    if state.get("Alive").and_then(Value::as_bool) == Some(false)
        || state.get("alive").and_then(Value::as_bool) == Some(false)
    {
        return None;
    }
    let delay = state.get("History").or_else(|| state.get("history"))?
        .as_array()?.last()?.get("delay")?.as_u64()?;
    u32::try_from(delay).ok().filter(|delay| *delay > 0)
}

fn group_summaries(v: &Value, order: &[String]) -> Vec<TrayGroup> {
    let Some(proxies) = v.get("proxies").and_then(Value::as_object) else { return Vec::new() };
    let mut groups: Vec<TrayGroup> = proxies.iter().filter_map(|(name, info)| {
        let kind = info.get("type").and_then(Value::as_str).unwrap_or("");
        // 未知类型只要具有 all，也保留为只读策略，不能猜测选择语义。
        if !matches!(kind, "Selector" | "URLTest" | "Fallback" | "LoadBalance" | "Relay")
            && !info.get("all").is_some_and(Value::is_array) { return None; }
        let mut seen = std::collections::HashSet::new();
        let all: Vec<&str> = info.get("all").and_then(Value::as_array).into_iter().flatten()
            .filter_map(Value::as_str).filter(|name| !name.is_empty() && seen.insert(*name)).collect();
        let now = if matches!(kind, "Selector" | "URLTest" | "Fallback") {
            info.get("now").and_then(Value::as_str).filter(|name| all.contains(name))
        } else { None };
        // 保留全部候选与原顺序；面板负责虚拟渲染，不在数据层截断。
        let target = group_latency_target(name);
        Some(TrayGroup {
            name: name.clone(), kind: kind.to_string(), now: now.map(String::from),
            manual: kind == "Selector", total: all.len(),
            nodes: all.iter().copied().map(|candidate| TrayNode {
                name: candidate.to_string(), selected: now == Some(candidate),
                delay: proxies.get(candidate).and_then(|node| target_latency(node, target)),
            }).collect(),
        })
    }).collect();
    let positions: std::collections::HashMap<&str, usize> = order.iter().enumerate()
        .map(|(index, name)| (name.as_str(), index)).collect();
    // /proxies 的对象没有订阅原序。未同步到的额外组稳定按名字尾附，GLOBAL最后。
    groups.sort_by(|a, b| {
        positions.get(a.name.as_str()).copied().unwrap_or(usize::MAX)
            .cmp(&positions.get(b.name.as_str()).copied().unwrap_or(usize::MAX))
            .then_with(|| (a.name == "GLOBAL").cmp(&(b.name == "GLOBAL")))
            .then_with(|| a.name.cmp(&b.name))
    });
    groups
}

fn node_action(value: &Value) -> Result<Value, String> {
    let group = value.get("group").and_then(Value::as_str).filter(|value| !value.is_empty());
    let node = value.get("node").and_then(Value::as_str).filter(|value| !value.is_empty());
    match (group, node) {
        (Some(group), Some(node)) => Ok(serde_json::json!({ "group": group, "node": node })),
        _ => Err("节点动作缺少策略或候选名称".to_string()),
    }
}

/// 箭头之外只留 5 格；格式化宽度是下限，必须先限制有效字符数。
fn speed_body(bps: f64) -> String {
    let mut value = if bps.is_finite() { bps.max(0.0) } else { 0.0 };
    let units = ['B', 'K', 'M', 'G'];
    let mut unit = 0;
    // 进位前先换单位，避免 1000K / 1000M；最高单位以 9999G 封顶。
    while value >= 999.5 && unit < units.len() - 1 {
        value /= 1000.0;
        unit += 1;
    }
    let value = value.min(9999.0);
    let s = if unit >= 2 && value < 99.95 {
        format!("{value:.1}{}", units[unit])
    } else {
        format!("{value:.0}{}", units[unit])
    };
    format!("{s:>5}")
}

fn render_speed_icon(up: f64, down: f64, color: [u8; 3]) -> Result<Image<'static>, String> {
    let lines = [format!("↑{}", speed_body(up)), format!("↓{}", speed_body(down))];
    let mut rgba = vec![0u8; SPEED_W * SPEED_H * 4];
    for (line_idx, line) in lines.iter().enumerate() {
        // 即便格式化逻辑以后改变，也不能写到下一行或越过图像缓冲区。
        for (char_idx, ch) in line.chars().take(SPEED_COLUMNS).enumerate() {
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
                    let dst = (((line_idx * GLYPH_H + gy) * SPEED_W) + (SPEED_W - GLYPH_W * SPEED_COLUMNS) + char_idx * GLYPH_W + gx)
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
    compose_indicator(state_img, speed, 8)
}

/// 保留眼睛状态色；头部与网速颜色跟随菜单栏自身外观。
fn render_menu_bar_icon(state: u8, up: f64, down: f64, show_speed: bool, dark: bool) -> Result<Image<'static>, String> {
    render_status_icon(state, up, down, show_speed, dark)
}

#[cfg(target_os = "macos")]
fn menu_bar_is_dark(app: &AppHandle) -> Result<bool, String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua};
    use objc2_foundation::NSArray;

    let tray = app.tray_by_id("main").ok_or("菜单栏图标尚未创建")?;
    // Tauri 保证此闭包在主线程执行；不把 AppKit 对象传回异步线程。
    tray.with_inner_tray_icon(|inner| {
        let Some(mtm) = MainThreadMarker::new() else { return false; };
        let Some(item) = inner.ns_status_item() else { return false; };
        let Some(button) = item.button(mtm) else { return false; };
        let names = NSArray::from_slice(&[unsafe { NSAppearanceNameAqua }, unsafe { NSAppearanceNameDarkAqua }]);
        button.effectiveAppearance().bestMatchFromAppearancesWithNames(&names)
            .is_some_and(|name| &*name == unsafe { NSAppearanceNameDarkAqua })
    }).map_err(|error| error.to_string())
}

fn indicator_state(running: bool, sys_proxy: bool, tun: bool) -> u8 {
    if !running { 0 } else if tun { 2 } else if sys_proxy { 1 } else { 0 }
}

fn compose_indicator(state_img: Image<'_>, speed: Image<'_>, gap: usize) -> Result<Image<'static>, String> {
    let state_w = state_img.width() as usize;
    let state_h = state_img.height() as usize;
    let speed_w = speed.width() as usize;
    let speed_h = speed.height() as usize;
    let width = state_w + gap + speed_w;
    let height = state_h.max(speed_h);
    let mut rgba = vec![0u8; width * height * 4];
    for (image, offset_x) in [(&state_img, 0), (&speed, state_w + gap)] {
        let image_w = image.width() as usize;
        let image_h = image.height() as usize;
        let offset_y = (height - image_h) / 2;
        for y in 0..image_h {
            let src = y * image_w * 4;
            let dst = ((y + offset_y) * width + offset_x) * 4;
            rgba[dst..dst + image_w * 4].copy_from_slice(&image.rgba()[src..src + image_w * 4]);
        }
    }
    Ok(Image::new_owned(rgba, width as u32, height as u32))
}

fn read_flags(app: &AppHandle) -> (bool, bool, bool, String) {
    let flags = app.state::<AppFlags>();
    let sys = *flags.sys_proxy_enabled.lock().unwrap();
    let tun = *flags.tun_enabled.lock().unwrap();
    let show = *flags.show_tray_speed.lock().unwrap();
    let mode = flags.mode.lock().unwrap().clone();
    (sys, tun, show, mode)
}

/// 更新菜单栏图标（状态 + 两行速率合成在一张图里）。
pub async fn update_indicator(app: &AppHandle) -> Result<(), String> {
    let (sys_proxy, tun, show_speed, _) = read_flags(app);
    let running = crate::kernel::is_running(app).await;
    let state = indicator_state(running, sys_proxy, tun);
    #[cfg(target_os = "macos")]
    let dark = menu_bar_is_dark(app)?;
    #[cfg(not(target_os = "macos"))]
    let dark = false;
    let rates = if running {
        crate::traffic::rates()
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
            let label = if !running {
                "未运行"
            } else if tun {
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
            let image = if cfg!(target_os = "macos") {
                render_menu_bar_icon(state, rates.0, rates.1, show_speed, dark)?
            } else {
                render_status_icon(state, rates.0, rates.1, show_speed, dark)?
            };
            tray.set_icon_with_as_template(Some(image), false)
                .map_err(|e| e.to_string())?;
            let _ = tray.set_title(None::<&str>);
        }
        if let Ok(mut last) = last_speed_label().lock() {
            *last = Some(label);
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

/// 前端概览读取与托盘/面板完全相同的速率缓存。
#[tauri::command]
pub fn traffic_rates() -> Result<(f64, f64), String> {
    Ok(crate::traffic::rates())
}

#[tauri::command]
pub async fn sync_tray(app: AppHandle) -> Result<(), String> {
    update_indicator(&app).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn set_tray_flags(
    app: AppHandle,
    tun_enabled: bool,
    sys_proxy_enabled: bool,
    mixed_port: u16,
    mode: String,
    show_speed: bool,
    hide_dock: bool,
    controller_secret: String,
    primary_group: String,
    group_order: Option<Vec<String>>,
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
        *flags.controller_secret.lock().unwrap() = controller_secret;
        *flags.mode.lock().unwrap() = mode;
        *flags.primary_group.lock().unwrap() = primary_group;
        *tray_group_order().lock().unwrap() = group_order.unwrap_or_default();
        *flags.show_tray_speed.lock().unwrap() = show_speed;
        *flags.hide_dock_on_close.lock().unwrap() = hide_dock;
    }
    update_indicator(&app).await
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileSummary {
    #[serde(default)]
    profiles: Vec<TrayProfile>,
    active_id: Option<String>,
}

#[derive(PartialEq, Eq)]
struct ProfileStamp {
    path: std::path::PathBuf,
    modified: std::time::SystemTime,
    len: u64,
}

// 只保留一份名称/配额摘要；不缓存订阅原文、链接或逐次打开历史。
static PROFILE_SUMMARY: OnceLock<Mutex<Option<(ProfileStamp, ProfileSummary)>>> = OnceLock::new();

fn read_profile_summary(path: std::path::PathBuf) -> ProfileSummary {
    let Ok(file) = std::fs::File::open(&path) else { return ProfileSummary::default() };
    let stamp = file.metadata().ok().and_then(|meta| Some(ProfileStamp {
        path, modified: meta.modified().ok()?, len: meta.len(),
    }));
    let cache = PROFILE_SUMMARY.get_or_init(|| Mutex::new(None));
    if let (Some(stamp), Ok(cached)) = (stamp.as_ref(), cache.lock()) {
        if let Some((old, summary)) = cached.as_ref() {
            if old == stamp { return summary.clone(); }
        }
    }
    // 流式跳过 raw/config 等未知字段，避免构造完整 JSON 树和原文副本。
    let reader = std::io::BufReader::new(file);
    let Ok(summary) = serde_json::from_reader::<_, ProfileSummary>(reader) else {
        return ProfileSummary::default();
    };
    if let (Some(stamp), Ok(mut cached)) = (stamp, cache.lock()) {
        *cached = Some((stamp, summary.clone()));
    }
    summary
}

fn load_profiles() -> ProfileSummary {
    crate::resources::data_dir().map(|dir| read_profile_summary(dir.join("state.json"))).unwrap_or_default()
}

#[tauri::command]
pub async fn tray_snapshot(app: AppHandle) -> Result<TraySnapshot, String> {
    let (sys_proxy, tun, show_speed, mode) = read_flags(&app);
    let running = crate::kernel::is_running(&app).await;
    let port = *app.state::<KernelState>().controller_port.lock().await;
    let secret = app.state::<AppFlags>().controller_secret.lock().unwrap().clone();
    let primary = if mode == "global" { "GLOBAL".to_string() } else { app.state::<AppFlags>().primary_group.lock().unwrap().clone() };
    let order = tray_group_order().lock().unwrap().clone();
    let (groups, groups_error) = if running {
        match fetch_groups(port, &secret, &order).await {
            Ok(groups) => (groups, None),
            Err(error) => (Vec::new(), Some(error)),
        }
    } else { (Vec::new(), None) };
    let default_group = groups.iter().find(|group| group.name == primary).or_else(|| groups.first());
    let node = default_group.and_then(|group| group.now.clone());
    let group = default_group.map(|group| group.name.clone());
    let nodes = default_group.map(|group| group.nodes.clone()).unwrap_or_default();
    let (up, down) = crate::traffic::rates();
    let summary = tauri::async_runtime::spawn_blocking(load_profiles).await.map_err(|e| e.to_string())?;
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
        groups,
        groups_error,
        profiles: summary.profiles,
        active_profile: summary.active_id,
        controller_port: port,
        controller_secret: secret,
    })
}

#[tauri::command]
pub async fn tray_action(
    app: AppHandle,
    action: String,
    value: Option<Value>,
) -> Result<(), String> {
    match action.as_str() {
        "restart" => {
            app.restart();
        }
        "close" => {
            hide_panel(&app);
        }
        "quit" => {
            // 退出前先恢复网络：否则系统代理/TUN 会指向已退出的内核。
            let flags = app.state::<AppFlags>();
            let sys = *flags.sys_proxy_enabled.lock().unwrap();
            let port = *flags.mixed_port.lock().unwrap();
            if sys {
                let _ = crate::sysproxy::set_system_proxy(false, "127.0.0.1".to_string(), port);
            }
            let _ = crate::kernel::stop_kernel(app.clone()).await;
            app.exit(0);
        }
        "sysproxy" => {
            let enable = value.as_ref().and_then(Value::as_str) == Some("true");
            let _ = app.emit("tray://panel-sysproxy", enable);
        }
        "tun" => {
            let _ = app.emit("tray://tun", ());
        }
        "mode" => {
            let Some(mode) = value.as_ref().and_then(Value::as_str) else {
                return Ok(());
            };
            *app.state::<AppFlags>().mode.lock().unwrap() = mode.to_string();
            let _ = app.emit("tray://mode", mode);
        }
        "profile" => {
            if let Some(id) = value.as_ref().and_then(Value::as_str) {
                let _ = app.emit("tray://panel-profile", id);
            }
        }
        "refresh-profile" => {
            let id = value.as_ref().and_then(Value::as_str).filter(|id| !id.is_empty()).ok_or("缺少订阅标识")?;
            let request = format!("{}-{}", std::process::id(), std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos());
            let (send, receive) = tokio::sync::oneshot::channel::<bool>();
            let send = Mutex::new(Some(send));
            let expected = request.clone();
            let listener = app.listen("tray://profile-refreshed", move |event| {
                let Ok(result) = serde_json::from_str::<Value>(event.payload()) else { return; };
                if result.get("request").and_then(Value::as_str) == Some(expected.as_str()) {
                    if let Some(send) = send.lock().ok().and_then(|mut send| send.take()) {
                        let _ = send.send(result.get("ok").and_then(Value::as_bool) == Some(true));
                    }
                }
            });
            let sent = app.emit("tray://refresh-profile", serde_json::json!({"id":id,"request":request}));
            let result = if sent.is_ok() {
                tokio::time::timeout(std::time::Duration::from_secs(90), receive).await
                    .ok().and_then(Result::ok).unwrap_or(false)
            } else { false };
            app.unlisten(listener);
            if !result { return Err("更新失败，请重试".to_string()); }
        }
        "node" => {
            let value = value.as_ref().ok_or("节点动作缺少参数")?;
            let _ = app.emit("tray://panel-node", node_action(value)?);
        }
        "open" => {
            crate::focus_main(&app);
            let _ = app.emit("tray://navigate", value.as_ref().and_then(Value::as_str).unwrap_or("overview"));
            hide_panel(&app);
        }
        _ => {}
    }
    Ok(())
}

/// 面板失焦时收起（由 lib 的窗口事件调用）。
pub fn hide_panel(app: &AppHandle) {
    if let Some(panel) = app.get_webview_window("tray-panel") {
        let _ = panel.hide();
    }
    if let Ok(mut at) = panel_hidden_at().lock() {
        *at = Some(Instant::now());
    }
    // 惰性创建且最多保留一个 WebView；前端隐藏时暂停请求，不积累销毁计时任务。
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
        if button != tauri::tray::MouseButton::Left && button != tauri::tray::MouseButton::Right {
            return;
        }
        toggle_panel(app, rect);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn profile_summary_cache_follows_file_changes_and_deletion() {
        let path = std::env::temp_dir().join(format!("ppclash-tray-summary-{}-{}.json",
            std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::write(&path, serde_json::json!({
            "activeId": "first", "profiles": [{"id":"first", "name":"订阅一", "raw":"x".repeat(1024 * 1024),
                "url":"https://private.example/subscribe?token=private", "updatedAt":1700000000000_f64,
                "userinfo":{"upload":1024,"download":2048,"total":8192,"expire":1805204537}}]
        }).to_string()).unwrap();
        let first = super::read_profile_summary(path.clone());
        assert_eq!(first.active_id.as_deref(), Some("first"));
        assert_eq!(first.profiles[0].name, "订阅一");
        assert_eq!(first.profiles[0].userinfo.as_ref().unwrap().total, 8192.0);
        assert_eq!(first.profiles[0].updated_at, Some(1700000000000_f64));
        let public = serde_json::to_string(&first.profiles).unwrap();
        assert!(!public.contains("token") && !public.contains("raw") && !public.contains("private.example"));
        assert_eq!(super::read_profile_summary(path.clone()).profiles[0].id, "first");
        std::fs::write(&path, r#"{"activeId":"second","profiles":[{"id":"second","name":"更新"}]}"#).unwrap();
        assert_eq!(super::read_profile_summary(path.clone()).active_id.as_deref(), Some("second"));
        std::fs::write(&path, "broken").unwrap();
        assert!(super::read_profile_summary(path.clone()).profiles.is_empty());
        std::fs::remove_file(&path).unwrap();
        assert!(super::read_profile_summary(path).profiles.is_empty());
    }

    #[test]
    fn group_latency_uses_only_the_matching_target_history() {
        for (group, expected) in [("常规", 21), ("开发", 82), ("GIT Hub", 82), ("代码", 82), ("程序", 82), ("GitHub 固定出口", 82)] {
            let value = serde_json::json!({"proxies": {
                (group): {"type":"Selector", "now":"A", "all":["A"]},
                "A": {"type":"Shadowsocks", "history":[{"delay":999}], "extra": {
                    "https://www.google.com/generate_204": {"Alive":true,"History":[{"delay":21}]},
                    "https://github.com/robots.txt": {"Alive":true,"History":[{"delay":82}]}
                }}
            }});
            let groups = super::group_summaries(&value, &[]);
            assert_eq!(groups[0].nodes[0].delay, Some(expected), "group={group}");
        }
    }

    #[test]
    fn group_latency_never_falls_back_to_unlabelled_or_failed_history() {
        for extra in [
            serde_json::json!({}),
            serde_json::json!({"https://www.gstatic.com/generate_204":{"History":[{"delay":21}]}}),
            serde_json::json!({"https://github.com/robots.txt":{"Alive":false,"History":[{"delay":82}]}}),
            serde_json::json!({"https://github.com/robots.txt":{"History":[{"delay":0}]}}),
        ] {
            let value = serde_json::json!({"proxies": {
                "开发":{"type":"Selector","now":"A","all":["A"]},
                "A":{"type":"Shadowsocks","history":[{"delay":999}],"extra":extra}
            }});
            let groups = super::group_summaries(&value, &[]);
            assert_eq!(groups[0].nodes[0].delay, None);
        }
    }

    #[test]
    fn retains_the_primary_group_candidates_and_global_mode() {
        let value = serde_json::json!({"proxies": {
            "A Region": {"type":"Selector","now":"other","all":["other"]},
            "Main": {"type":"Selector","now":"Auto","all":["Auto"]},
            "Auto": {"type":"Selector","now":"chosen","all":["chosen","other"]},
            "GLOBAL": {"type":"Selector","now":"other","all":["chosen","other"]},
            "chosen": {"type":"Shadowsocks"}, "other": {"type":"Shadowsocks"}
        }});
        let groups = super::group_summaries(&value, &["Main".to_string(), "Auto".to_string()]);
        assert_eq!(groups[0].name, "Main");
        assert_eq!(groups[0].now.as_deref(), Some("Auto"));
        assert_eq!(groups[0].nodes.iter().map(|node| node.name.as_str()).collect::<Vec<_>>(), vec!["Auto"]);
        assert_eq!(groups[1].name, "Auto");
        assert_eq!(groups[1].nodes.len(), 2);
        let global = groups.iter().find(|group| group.name == "GLOBAL").unwrap();
        assert_eq!(global.now.as_deref(), Some("other"));
    }

    #[test]
    fn summary_keeps_config_order_unknown_types_and_all_candidates() {
        let names: Vec<String> = (0..2000).map(|index| format!("候选 {index}")).collect();
        let value = serde_json::json!({"proxies": {
            "Z | 任意名字": {"type":"Selector", "now":"候选 1999", "all":names},
            "A": {"type":"URLTest", "now":"DIRECT", "all":["DIRECT"]},
            "未知": {"type":"FuturePolicy", "now":"DIRECT", "all":["DIRECT"]},
            "GLOBAL": {"type":"Selector", "now":"A", "all":["A"]}
        }});
        let groups = super::group_summaries(&value, &["Z | 任意名字".to_string(), "A".to_string()]);
        assert_eq!(groups.iter().map(|group| group.name.as_str()).collect::<Vec<_>>(), vec!["Z | 任意名字", "A", "未知", "GLOBAL"]);
        assert_eq!(groups[0].total, 2000);
        assert_eq!(groups[0].nodes.len(), 2000);
        assert_eq!(groups[0].nodes[0].name, "候选 0");
        assert_eq!(groups[0].nodes[1999].name, "候选 1999");
        assert!(groups[0].nodes[1999].selected);
        assert!(groups[0].manual);
        assert!(!groups[1].manual);
        assert!(!groups[2].manual);
        assert!(groups[2].now.is_none());
        assert!(!groups[2].nodes[0].selected);
    }

    #[test]
    fn automatic_and_multi_path_groups_never_claim_manual_or_unique_selection() {
        for kind in ["URLTest", "Fallback", "LoadBalance", "Relay", "FuturePolicy"] {
            let value = serde_json::json!({"proxies": {"任意策略": {"type":kind,"now":"A","all":["A","B"]}}});
            let groups = super::group_summaries(&value, &[]);
            let group = &groups[0];
            assert!(!group.manual, "type={kind}");
            if matches!(kind, "URLTest" | "Fallback") {
                assert_eq!(group.now.as_deref(), Some("A"));
            } else {
                assert!(group.now.is_none());
                assert!(group.nodes.iter().all(|node| !node.selected));
            }
        }
    }

    #[test]
    fn stale_selection_is_not_added_as_an_out_of_group_candidate() {
        let value = serde_json::json!({"proxies": {"父组": {"type":"Selector","now":"旧节点","all":["DIRECT", "子组", "REJECT", "DIRECT"]}}});
        let groups = super::group_summaries(&value, &[]);
        assert_eq!(groups[0].total, 3);
        assert!(groups[0].now.is_none());
        assert_eq!(groups[0].nodes.iter().map(|node| node.name.as_str()).collect::<Vec<_>>(), vec!["DIRECT", "子组", "REJECT"]);
        assert!(groups[0].nodes.iter().all(|node| !node.selected));
    }

    #[test]
    fn structured_node_action_preserves_arbitrary_names_and_rejects_ambiguous_legacy_values() {
        let value = serde_json::json!({"group":"工作 | 国际", "node":"节点 | 美国"});
        assert_eq!(super::node_action(&value).unwrap(), value);
        for invalid in [serde_json::json!("工作 | 国际|节点 | 美国"), serde_json::json!("A|B"),
            serde_json::json!({"group":"A"}), serde_json::json!({"group":"", "node":"B"}),
            serde_json::json!({"group":"A", "node":12})] {
            assert!(super::node_action(&invalid).is_err());
        }
    }
    use super::*;

    #[test]
    fn menu_bar_preserves_status_eye_colors() {
        let icon = render_menu_bar_icon(0, 0.0, 0.0, false, false).unwrap();
        assert!(icon.rgba().chunks_exact(4).any(|pixel|
            pixel[3] > 0 && pixel[0] != pixel[1]), "菜单栏不能用单色模板覆盖状态眼睛");
    }

    #[test]
    fn menu_bar_keeps_width_spacing_and_brand_silhouette() {
        let idle = render_menu_bar_icon(0, 0.0, 0.0, false, false).unwrap();
        let slow = render_menu_bar_icon(0, 0.0, 12_000.0, true, false).unwrap();
        let fast = render_menu_bar_icon(0, f64::MAX, f64::MAX, true, false).unwrap();
        assert_eq!((slow.width(), slow.height()), (136, 44));
        assert_eq!((slow.width(), slow.height()), (fast.width(), fast.height()));
        assert_eq!((idle.width(), idle.height()), (44, 44));
        for row in slow.rgba().chunks_exact(slow.width() as usize * 4) {
            assert!(row[44 * 4..52 * 4].chunks_exact(4).all(|pixel| pixel[3] == 0));
        }
        let template = Image::from_bytes(ICON_TEMPLATE).unwrap();
        // 有色状态只填充眼睛；模板中的猫头轮廓不能被另一套图形替换。
        for (mask, pixel) in template.rgba().chunks_exact(4).zip(idle.rgba().chunks_exact(4)) {
            assert!(pixel[3] >= mask[3]);
        }
        let pixel = |icon: &Image<'_>, x: usize, y: usize| icon.rgba()[(y * 44 + x) * 4..(y * 44 + x) * 4 + 3].to_vec();
        let proxy = render_menu_bar_icon(1, 0.0, 0.0, false, false).unwrap();
        let tun = render_menu_bar_icon(2, 0.0, 0.0, false, true).unwrap();
        assert_eq!(pixel(&proxy, 14, 27), vec![0x78, 0xa5, 0xff]);
        assert_eq!(pixel(&tun, 14, 27), vec![0x70, 0xd2, 0xad]);
        assert_ne!(pixel(&idle, 22, 20), pixel(&tun, 22, 20));
    }

    #[test]
    fn stopped_kernel_cannot_show_a_connected_eye_color() {
        assert_eq!(indicator_state(false, true, true), 0);
        assert_eq!(indicator_state(true, false, false), 0);
        assert_eq!(indicator_state(true, true, false), 1);
        assert_eq!(indicator_state(true, true, true), 2);
    }

    #[test]
    fn speed_icon_handles_high_download_rates() {
        for rate in [100_000_000.0, 999_999_999.0, f64::MAX, f64::INFINITY, f64::NAN, -1.0] {
            let img = render_speed_icon(rate, rate, [0, 0, 0]).unwrap();
            assert_eq!(img.rgba().len(), SPEED_W * SPEED_H * 4);
            assert!(img.rgba().chunks_exact(4).any(|pixel| pixel[3] > 0));
        }
    }

    #[test]
    fn speed_labels_fit_the_icon_at_unit_boundaries() {
        for (rate, expected) in [
            (0.0, "0B"),
            (12_300.0, "12K"),
            (999_999.0, "1.0M"),
            (1_000_000.0, "1.0M"),
            (99_999_999.0, "100M"),
            (100_000_000.0, "100M"),
            (999_999_999.0, "1.0G"),
            (1_000_000_000.0, "1.0G"),
            (100_000_000_000.0, "100G"),
            (f64::MAX, "9999G"),
            (-1.0, "0B"),
            (f64::NAN, "0B"),
            (f64::INFINITY, "0B"),
        ] {
            let label = speed_body(rate);
            assert_eq!(label.trim(), expected, "rate={rate}");
            assert_eq!(label.chars().count(), 5, "rate={rate}, label={label}");
        }
    }

    #[test]
    fn speed_icon_has_pixels() {
        let img = render_speed_icon(12_300.0, 456_000.0, [0, 0, 0]).unwrap();
        assert_eq!((img.width(), img.height()), (SPEED_W as u32, SPEED_H as u32));
        let opaque = img.rgba().chunks(4).filter(|p| p[3] > 0).count();
        assert!(opaque > 50, "speed icon should not be empty, opaque={opaque}");
        std::fs::write("/tmp/speed-icon.raw", img.rgba()).unwrap();
    }
}
