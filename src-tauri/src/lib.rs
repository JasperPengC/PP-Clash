mod icons;
mod kernel;
mod leakcheck;
mod mihomo;
mod prefs;
mod resources;
mod subscription;
mod sysproxy;
mod tray;

use kernel::KernelState;
use prefs::AppFlags;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::tray::TrayIconBuilder;
use tauri::{ActivationPolicy, Manager, WindowEvent};

static HIDDEN_TO_TRAY: AtomicBool = AtomicBool::new(false);

/// 菜单栏常驻：禁止 macOS 在最后一个窗口关闭后自动终止进程。
#[cfg(target_os = "macos")]
fn disable_automatic_termination() {
    use objc2_foundation::{ns_string, NSProcessInfo};
    NSProcessInfo::processInfo()
        .disableAutomaticTermination(ns_string!("PP Clash menu bar resident"));
}

#[cfg(not(target_os = "macos"))]
fn disable_automatic_termination() {}

/// 把主窗口叫到前台。托盘点击和菜单项都走这里。
pub fn focus_main(app: &tauri::AppHandle) {
    // 从托盘/面板唤回主窗口时恢复 Dock 图标
    HIDDEN_TO_TRAY.store(false, Ordering::Relaxed);
    let _ = app.set_activation_policy(ActivationPolicy::Regular);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(KernelState::default())
        .manage(AppFlags::default())
        .invoke_handler(tauri::generate_handler![
            resources::reinstall_bundled_resources,
            resources::list_kernel_versions,
            resources::list_resource_files,
            resources::download_kernel_version,
            kernel::kernel_status,
            kernel::kernel_info,
            kernel::validate_config,
            kernel::read_kernel_log,
            kernel::start_kernel,
            kernel::stop_kernel,
            kernel::cleanup_stale_kernel,
            icons::resolve_process_icon,
            subscription::fetch_subscription,
            subscription::save_config,
            subscription::save_app_state,
            subscription::load_app_state,
            subscription::backup_app_state,
            subscription::list_backups,
            subscription::restore_backup,
            mihomo::mihomo_request,
            sysproxy::set_system_proxy,
            sysproxy::get_system_proxy,
            prefs::set_close_to_tray,
            prefs::set_launch_login,
            prefs::open_data_dir,
            tray::sync_tray,
            tray::set_tray_flags,
            tray::tray_snapshot,
            tray::tray_action,
            leakcheck::leak_check_ip,
            leakcheck::leak_check_dns,
        ])
        .setup(|app| {
            disable_automatic_termination();
            // 兜底：无论窗口配置怎么变，启动后都把主窗口显示出来并置前
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }

            // 托盘用单色模板图：icon_as_template 让 macOS 自适应明暗菜单栏
            TrayIconBuilder::with_id("main")
                .icon(tauri::include_image!("icons/tray_icon.png"))
                .icon_as_template(true)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| tray::on_tray_click(tray.app_handle(), event))
                .build(app)?;

            // 菜单内容按当前状态异步重建（内核状态 / 分组节点 / 代理开关）
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = tray::rebuild(&handle).await {
                    eprintln!("[tray] 初始菜单构建失败：{e}");
                }
            });

            // 每秒刷新托盘图标状态与实时网速；不重建菜单
            let tick_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    let _ = tray::tick(&tick_handle).await;
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::Focused(true) = event {
                    let _ = window
                        .app_handle()
                        .set_activation_policy(ActivationPolicy::Regular);
                }
            }
            if window.label() == "tray-panel" {
                if let WindowEvent::Focused(false) = event {
                    tray::hide_panel(&window.app_handle());
                }
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                // 关窗行为跟随设置：最小化到托盘（默认）或真正退出
                let to_tray = *window
                    .state::<AppFlags>()
                    .close_to_tray
                    .lock()
                    .unwrap();
                if to_tray {
                    api.prevent_close();
                    HIDDEN_TO_TRAY.store(true, Ordering::Relaxed);
                    let _ = window.hide();
                    let hide_dock = *window
                        .state::<AppFlags>()
                        .hide_dock_on_close
                        .lock()
                        .unwrap();
                    if hide_dock {
                        let _ = window
                            .app_handle()
                            .set_activation_policy(ActivationPolicy::Accessory);
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
            // 用户点红点 / Cmd+W 关闭最后一个窗口时，Tauri 会请求退出；
            // 开了「关窗到托盘」且窗口已隐藏时拦下，让进程和菜单栏继续常驻。
            // 托盘「退出」走 app.exit()，code 为 Some，不受影响。
            if code.is_none() {
                let to_tray = *app_handle
                    .state::<AppFlags>()
                    .close_to_tray
                    .lock()
                    .unwrap();
                let hidden = HIDDEN_TO_TRAY.load(Ordering::Relaxed)
                    || app_handle
                        .get_webview_window("main")
                        .map(|w| !w.is_visible().unwrap_or(false))
                        .unwrap_or(false);
                if to_tray && hidden {
                    HIDDEN_TO_TRAY.store(true, Ordering::Relaxed);
                    api.prevent_exit();
                }
            }
        }
    });
}
