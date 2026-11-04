use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Manager;
use tokio::process::Child;
use tokio::sync::Mutex;

use crate::resources;

/// 内核进程的状态。整个应用只持有一份。
pub struct KernelState {
    /// 直接 spawn 时的子进程句柄。osascript 提权启动时无法跟踪，留 None。
    child: Mutex<Option<Child>>,
    /// 上一次是否用 osascript 提权启动（非 setuid 内核的 TUN 兜底路径）。
    privileged: Mutex<bool>,
    /// mihomo 控制端口，用于无法跟踪 pid 时探测存活。托盘/泄漏自检也会读。
    pub controller_port: Mutex<u16>,
    /// 当前内核使用的配置文件路径：osascript 启动时用它精确定位进程。
    config_path: Mutex<Option<String>>,
    /// 当前内核二进制路径（内核信息展示）。
    binary_path: Mutex<Option<String>>,
    /// 防止并发 start 互相踩踏（前端状态更新前的竞态）。
    start_lock: tokio::sync::Mutex<()>,
}

impl Default for KernelState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            privileged: Mutex::new(false),
            controller_port: Mutex::new(9090),
            config_path: Mutex::new(None),
            binary_path: Mutex::new(None),
            start_lock: tokio::sync::Mutex::new(()),
        }
    }
}

#[derive(Serialize, Clone)]
pub struct KernelStatus {
    pub running: bool,
    pub pid: Option<u32>,
    /// 启动前自动清理掉的端口占用进程 pid。
    pub reclaimed: Vec<u32>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KernelInfo {
    pub running: bool,
    pub version: Option<String>,
    pub pid: Option<u32>,
    pub rss_kb: Option<u64>,
    pub binary: Option<String>,
    pub bundled_version: Option<String>,
}

/// 内核二进制是否带 setuid root 位。
#[cfg(unix)]
fn is_setuid(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.permissions().mode() & 0o4000 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_setuid(_path: &Path) -> bool {
    false
}

/// 从生成的配置里读代理端口、控制端口与 DNS 监听端口（配置是 JSON）。
fn config_ports(config_path: &Path) -> (u16, u16, u16, Vec<u16>) {
    let text = std::fs::read_to_string(config_path).unwrap_or_default();
    let value: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    let mixed = value
        .get("mixed-port")
        .and_then(|v| v.as_u64())
        .unwrap_or(7890) as u16;
    let controller = value
        .get("external-controller")
        .and_then(|v| v.as_str())
        .and_then(|s| s.rsplit(':').next())
        .and_then(|s| s.parse().ok())
        .unwrap_or(9090);
    let dns = value
        .get("dns")
        .and_then(|v| v.get("listen"))
        .and_then(|v| v.as_str())
        .and_then(|s| s.rsplit(':').next())
        .and_then(|s| s.parse().ok())
        .unwrap_or(1053);
    let extra = ["socks-port", "port", "redir-port"]
        .iter()
        .filter_map(|key| value.get(*key).and_then(|v| v.as_u64()))
        .filter(|p| *p > 0)
        .map(|p| p as u16)
        .collect();
    (mixed, controller, dns, extra)
}

fn tcp_port_free(port: u16) -> bool {
    // 用「是否有进程在监听」判断，而不是试 bind：
    // 上一轮连接留下的 TIME_WAIT 会阻止裸 bind，但 mihomo 使用 SO_REUSEADDR 可以正常启动。
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(80)).is_err()
}

fn udp_port_free(port: u16) -> bool {
    std::net::UdpSocket::bind(("127.0.0.1", port)).is_ok()
}

fn tcp_port_open(port: u16) -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok()
}

/// 启动前检查端口。刚重启内核时端口可能还没释放，先等最多 3 秒。
#[cfg(not(target_os = "windows"))]
fn current_uid() -> Option<u32> {
    let out = crate::platform::command("id").arg("-u").output().ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

#[cfg(not(target_os = "windows"))]
fn pid_uid(pid: u32) -> Option<u32> {
    let out = crate::platform::command("ps")
        .args(["-o", "uid=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

#[cfg(not(target_os = "windows"))]
fn pid_ppid(pid: u32) -> Option<u32> {
    let out = crate::platform::command("ps")
        .args(["-o", "ppid=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

#[cfg(not(target_os = "windows"))]
fn pid_alive(pid: u32) -> bool {
    crate::platform::command("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
fn signal(pid: u32, sig: &str) {
    let _ = crate::platform::command("kill")
        .arg(format!("-{sig}"))
        .arg(pid.to_string())
        .status();
}

#[cfg(not(target_os = "windows"))]
fn terminate(pid: u32) {
    signal(pid, "TERM");
    for _ in 0..10 {
        if !pid_alive(pid) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    signal(pid, "KILL");
}

/// 列出监听指定端口的进程 pid。
#[cfg(not(target_os = "windows"))]
fn listeners(port: u16, tcp: bool) -> Vec<u32> {
    let mut cmd = crate::platform::command("lsof");
    cmd.args(["-nP", "-t", &format!("-i{}:{}", if tcp { "TCP" } else { "UDP" }, port)]);
    if tcp {
        cmd.args(["-sTCP:LISTEN"]);
    }
    let Ok(out) = cmd.output() else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| line.trim().parse().ok())
        .collect()
}

#[cfg(target_os = "windows")]
fn tasklist_field(pid: u32) -> Option<String> {
    let out = crate::platform::command("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    text.lines().next().map(|s| s.to_string())
}

#[cfg(target_os = "windows")]
fn pid_alive(pid: u32) -> bool {
    tasklist_field(pid)
        .map(|line| line.contains(&pid.to_string()) && !line.contains("No tasks"))
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn signal(pid: u32, _sig: &str) {
    let _ = crate::platform::command("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status();
}

#[cfg(target_os = "windows")]
fn terminate(pid: u32) {
    signal(pid, "KILL");
}

#[cfg(target_os = "windows")]
fn terminate_elevated(pid: u32) {
    // TUN 内核由 UAC 以管理员权限启动，普通 taskkill 会拒绝访问；
    // 停止时再借一次管理员权限（UAC 确认）。
    let ps = format!(
        "$p = Start-Process -FilePath taskkill -ArgumentList @('/PID','{}','/T','/F') -Verb RunAs -WindowStyle Hidden -PassThru -Wait; exit $p.ExitCode",
        pid
    );
    let _ = crate::platform::command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &ps])
        .status();
}

#[cfg(target_os = "windows")]
fn listeners(port: u16, tcp: bool) -> Vec<u32> {
    let proto = if tcp { "TCP" } else { "UDP" };
    let out = match crate::platform::command("netstat")
        .args(["-ano", "-p", proto])
        .output()
    {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    let needle = format!(":{port}");
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|line| line.contains(&needle))
        .filter(|line| !tcp || line.to_ascii_uppercase().contains("LISTENING"))
        .filter_map(|line| line.split_whitespace().last()?.parse().ok())
        .collect()
}

#[cfg(target_os = "windows")]
fn current_uid() -> Option<u32> {
    None
}

#[cfg(target_os = "windows")]
fn pid_uid(_pid: u32) -> Option<u32> {
    None
}

#[cfg(target_os = "windows")]
fn pid_ppid(_pid: u32) -> Option<u32> {
    None
}

#[cfg(target_os = "windows")]
fn pid_of_process(config_path: &str) -> Option<u32> {
    let script = format!(
        "$p = Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -like '*{}*' }} | Select-Object -First 1 -ExpandProperty ProcessId; $p",
        config_path.replace('\'', "''")
    );
    let out = crate::platform::command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

#[cfg(target_os = "windows")]
fn rss_kb(pid: u32) -> Option<u64> {
    let line = tasklist_field(pid)?;
    let cols: Vec<&str> = line.split(',').collect();
    let mem = cols.get(4)?.trim_matches('"').replace(" K", "").replace("K", "");
    let kb: f64 = mem.replace(',', "").parse().ok()?;
    Some(kb as u64)
}

/// 端口被占时自动关闭占用进程：先杀当前用户的监听进程；
/// 如果是 root 子进程，则向上找当前用户的应用进程并关闭。
fn reclaim_ports(ports: &[(u16, bool)]) -> Vec<u32> {
    let me = std::process::id();
    let my_uid = current_uid();
    let mut killed = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for (port, tcp) in ports {
        for pid in listeners(*port, *tcp) {
            if pid <= 1 || pid == me || !seen.insert(pid) {
                continue;
            }
            // 先直接尝试结束监听进程：setuid 内核的 ruid 仍是当前用户，通常可以直接 SIGTERM
            terminate(pid);
            if ports_free(&[(*port, *tcp)]) {
                killed.push(pid);
                continue;
            }
            if let (Some(uid), Some(my)) = (pid_uid(pid), my_uid) {
                if uid == my {
                    if !killed.contains(&pid) {
                        killed.push(pid);
                    }
                    continue;
                }
            }
            // root 监听进程：尝试关闭它的用户态父进程（例如 Clash Party 主程序）
            let mut cursor = pid;
            for _ in 0..4 {
                let Some(parent) = pid_ppid(cursor) else { break };
                if parent <= 1 {
                    break;
                }
                if matches!((pid_uid(parent), my_uid), (Some(uid), Some(my)) if uid == my && parent != me)
                {
                    terminate(parent);
                    killed.push(parent);
                    break;
                }
                cursor = parent;
            }
        }
    }

    if !ports_free(ports) {
        // 常见代理客户端：关闭其用户态主程序，避免残留 root sidecar 占着端口
        for pattern in [
            "/Applications/Clash Party.app/Contents/MacOS/Clash Party",
            "/Applications/ClashX Pro.app/Contents/MacOS/ClashX Pro",
            "/Applications/ClashX.app/Contents/MacOS/ClashX",
            "/Applications/Clash Verge.app/Contents/MacOS/Clash Verge",
            "/Applications/FlClash.app/Contents/MacOS/FlClash",
        ] {
            if let Ok(out) = crate::platform::command("pgrep")
                .args(["-f", pattern])
                .output()
            {
                for pid in String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .filter_map(|line| line.trim().parse::<u32>().ok())
                {
                    if !killed.contains(&pid) {
                        killed.push(pid);
                    }
                }
            }
            let _ = crate::platform::command("pkill")
                .args(["-TERM", "-f", pattern])
                .status();
        }
        for _ in 0..20 {
            if ports_free(ports) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    killed.sort_unstable();
    killed.dedup();
    killed
}

fn ports_free(ports: &[(u16, bool)]) -> bool {
    ports.iter().all(|(port, tcp)| {
        if *tcp {
            tcp_port_free(*port)
        } else {
            udp_port_free(*port)
        }
    })
}

async fn preflight_ports(
    mixed_port: u16,
    controller_port: u16,
    dns_port: u16,
    extra_ports: &[u16],
) -> Result<Vec<u32>, String> {
    let mut ports = vec![
        (mixed_port, true),
        (controller_port, true),
        (dns_port, true),
        (dns_port, false),
    ];
    ports.extend(extra_ports.iter().map(|p| (*p, true)));

    if ports_free(&ports) {
        return Ok(Vec::new());
    }

    // 先给旧内核退出时间（setuid 内核收到 TERM 后可能需要几秒清理 TUN/端口）
    for _ in 0..30 {
        if ports_free(&ports) {
            return Ok(Vec::new());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let kill_ports = ports.clone();
    let killed = tokio::task::spawn_blocking(move || reclaim_ports(&kill_ports))
        .await
        .unwrap_or_default();

    for _ in 0..100 {
        if ports_free(&ports) {
            return Ok(killed);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let busy = if !tcp_port_free(mixed_port) {
        format!("混合端口 {mixed_port}")
    } else if !tcp_port_free(controller_port) {
        format!("控制端口 {controller_port}")
    } else if !tcp_port_free(dns_port) || !udp_port_free(dns_port) {
        format!("DNS 端口 {dns_port}")
    } else if let Some(p) = extra_ports.iter().find(|p| !tcp_port_free(**p)) {
        format!("端口 {p}")
    } else {
        "端口".to_string()
    };
    Err(format!(
        "{busy} 仍被占用，占用进程可能是系统级权限，已尝试自动关闭但失败。"
    ))
}

/// 探测控制端口是否可连，能连上说明内核活着。
async fn probe_controller(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/version");
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    matches!(client.get(&url).send().await, Ok(resp) if resp.status().is_success())
}

async fn controller_version(port: u16) -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
        .ok()?;
    let resp = client
        .get(format!("http://127.0.0.1:{port}/version"))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let text = resp.text().await.ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value
        .get("version")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// 内核是否在运行（探测控制端口）。托盘与泄漏自检共用，不改动任何状态。
pub async fn is_running(app: &tauri::AppHandle) -> bool {
    let port = *app.state::<KernelState>().controller_port.lock().await;
    probe_controller(port).await
}

/// 取内核日志最后几行，拼进错误信息里。
fn log_tail(path: &Path) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let mut lines: Vec<&str> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .rev()
        .take(3)
        .collect();
    if lines.is_empty() {
        return String::new();
    }
    lines.reverse();
    format!("内核日志：{}", lines.join(" | "))
}

/// 从内核日志里找 TUN 创建失败的错误行（mihomo 在 TUN 失败时不会退出）。
fn tun_error_line(log_path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(log_path).unwrap_or_default();
    for line in text.lines() {
        let lower = line.to_lowercase();
        if lower.contains("[tun]") && (lower.contains("error") || lower.contains("failed")) {
            return Some(line.trim().to_string());
        }
    }
    None
}

/// 等控制端口真正可连才算启动成功；期间盯着子进程是否已经退出。
async fn wait_ready(
    port: u16,
    mut child: Option<&mut Child>,
    log_path: &Path,
    what: &str,
) -> Result<KernelStatus, String> {
    let deadline = Instant::now() + Duration::from_secs(30);

    loop {
        tokio::time::sleep(Duration::from_millis(250)).await;

        if probe_controller(port).await {
            let pid = child.as_ref().and_then(|c| c.id());
            return Ok(KernelStatus {
                running: true,
                pid,
                reclaimed: Vec::new(),
            });
        }

        if let Some(c) = child.as_deref_mut() {
            match c.try_wait() {
                Ok(Some(status)) => {
                    return Err(format!(
                        "{}启动后退出（{status}）。{}",
                        what,
                        log_tail(log_path)
                    ));
                }
                Ok(None) => {}
                Err(_) => {}
            }
        }

        if Instant::now() >= deadline {
            return Err(format!(
                "{} 30 秒内未就绪：端口 {port} 被占用或 Geo 数据异常。{}",
                what,
                log_tail(log_path)
            ));
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn pid_of_process(config_path: &str) -> Option<u32> {
    let out = crate::platform::command("pgrep")
        .arg("-f")
        .arg(config_path)
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .and_then(|s| s.trim().parse().ok())
}

#[cfg(not(target_os = "windows"))]
fn rss_kb(pid: u32) -> Option<u64> {
    let out = crate::platform::command("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

#[tauri::command]
pub async fn kernel_status(app: tauri::AppHandle) -> Result<KernelStatus, String> {
    let state = app.state::<KernelState>();
    let port = *state.controller_port.lock().await;

    if probe_controller(port).await {
        let pid = state.child.lock().await.as_ref().and_then(|c| c.id());
        return Ok(KernelStatus {
            running: true,
            pid,
            reclaimed: Vec::new(),
        });
    }

    // 连不上：清掉残留状态，下次启动重新拉起
    *state.child.lock().await = None;
    *state.privileged.lock().await = false;
    // 等端口真正释放再返回：否则紧接着的 restart 会撞上「仍被占用」
    if let Some(cfg) = state.config_path.lock().await.clone() {
        let (mixed, controller, _, _) = config_ports(Path::new(&cfg));
        for _ in 0..80 {
            if tcp_port_free(mixed) && tcp_port_free(controller) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    Ok(KernelStatus {
        running: false,
        pid: None,
        reclaimed: Vec::new(),
    })
}

/// 内核信息：版本 / 内存 / 路径（设置页展示）。
#[tauri::command]
pub async fn kernel_info(app: tauri::AppHandle) -> Result<KernelInfo, String> {
    let state = app.state::<KernelState>();
    let port = *state.controller_port.lock().await;
    let running = probe_controller(port).await;
    let bundled_version = resources::bundled_version(&app);

    if !running {
        let binary = state.binary_path.lock().await.clone();
        return Ok(KernelInfo {
            running: false,
            version: None,
            pid: None,
            rss_kb: None,
            binary,
            bundled_version,
        });
    }

    let version = controller_version(port).await;
    let child_pid = {
        let guard = state.child.lock().await;
        guard.as_ref().and_then(|c| c.id())
    };
    let config_path = state.config_path.lock().await.clone();
    let binary = state.binary_path.lock().await.clone();
    let pid = child_pid.or_else(|| config_path.as_deref().and_then(pid_of_process));

    Ok(KernelInfo {
        running: true,
        version,
        pid,
        rss_kb: pid.and_then(rss_kb),
        binary,
        bundled_version,
    })
}

#[tauri::command]
pub async fn read_kernel_log(lines: usize) -> Result<String, String> {
    resources::read_log_tail(lines.min(2000))
}

#[tauri::command]
pub async fn start_kernel(
    app: tauri::AppHandle,
    binary_path: Option<String>,
    config_path: String,
    data_dir: String,
    privileged: bool,
    controller_port: u16,
) -> Result<KernelStatus, String> {
    let state = app.state::<KernelState>();
    let _start_guard = state
        .start_lock
        .try_lock()
        .map_err(|_| "内核正在启动，请稍候".to_string())?;
    // 先清理残留（包括上次崩溃/强退留下的 TUN 内核）
    let _ = stop_kernel(app.clone()).await;
    #[cfg(target_os = "windows")]
    {
        if let Some(pid) = pid_of_process(&config_path) {
            terminate(pid);
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = crate::platform::command("pkill")
            .arg("-f")
            .arg(&config_path)
            .status();
    }

    // 确保内置内核与 Geo 数据已释放到用户目录
    let (user_bin, bundled_version) = resources::ensure_kernel(&app)?;

    let explicit = binary_path.and_then(|p| {
        let path = PathBuf::from(p);
        path.is_file().then_some(path)
    });

    let mut binary = explicit.clone().unwrap_or_else(|| user_bin.clone());
    let mut use_osascript = false;

    if privileged {
        match explicit {
            Some(ref path) => {
                // 用户自定义内核：不是 setuid 就只能 osascript 提权
                use_osascript = !is_setuid(path);
            }
            None => {
                #[cfg(target_os = "macos")]
                {
                    // 内置内核：安装一份 setuid root 的系统副本，TUN 不弹密码
                    binary = resources::ensure_system_kernel(&user_bin, &bundled_version)
                        .map_err(|e| format!("TUN 需要安装一次提权内核：{e}"))?;
                }
                #[cfg(target_os = "windows")]
                {
                    // Windows 没有 setuid：用 UAC 提权启动用户目录内核
                    use_osascript = true;
                }
                #[cfg(not(any(target_os = "macos", target_os = "windows")))]
                {
                    return Err("当前平台暂未实现 TUN".to_string());
                }
            }
        }
        #[cfg(target_os = "windows")]
        if crate::platform::is_elevated() {
            // 整个应用已经是管理员：直接 spawn，省掉再起一个 UAC 子进程。
            use_osascript = false;
        }
    }

    let config = PathBuf::from(&config_path);
    if !config.is_file() {
        return Err(format!("配置文件不存在：{config_path}"));
    }

    let data = PathBuf::from(&data_dir);
    std::fs::create_dir_all(&data).map_err(|e| format!("创建工作目录失败：{e}"))?;

    // TUN 内核以 root 运行过时会把 cache.db 写成 root 属主；下次普通启动
    // 无法写这个文件，mihomo 会反复报 cache permission denied。目录属于当前用户，
    // 直接删掉缓存让内核重建。
    for name in ["cache.db", "cache.db-wal", "cache.db-shm"] {
        let p = data.join(name);
        if p.exists() {
            let _ = std::fs::remove_file(p);
        }
    }

    let log_path = data.join("kernel.log");
    let log_file = std::fs::File::create(&log_path).map_err(|e| format!("创建内核日志失败：{e}"))?;

    let (mixed_port, cfg_controller_port, dns_port, extra_ports) = config_ports(&config);
    let reclaimed = preflight_ports(
        mixed_port,
        cfg_controller_port.max(controller_port),
        dns_port,
        &extra_ports,
    )
    .await?;

    let state = app.state::<KernelState>();
    *state.controller_port.lock().await = controller_port;
    *state.privileged.lock().await = use_osascript;
    *state.config_path.lock().await = Some(config_path.clone());
    *state.binary_path.lock().await = Some(binary.display().to_string());

    if use_osascript {
        #[cfg(target_os = "windows")]
        {
            let ps = format!(
                "$p = Start-Process -FilePath '{}' -ArgumentList @('-d','{}','-f','{}') -Verb RunAs -WindowStyle Hidden -PassThru; exit $p.Id",
                binary.display(),
                data.display(),
                config.display()
            );
            let status = crate::platform::async_command("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
                .status()
                .await
                .map_err(|e| format!("UAC 提权启动失败：{e}"))?;
            if !status.success() {
                return Err("提权被取消：TUN 需要管理员权限".to_string());
            }
            let mut st = wait_ready(controller_port, None, &log_path, "TUN 内核").await?;
            st.reclaimed = reclaimed.clone();
            tokio::time::sleep(Duration::from_millis(300)).await;
            if !tcp_port_open(mixed_port) {
                return Err(format!(
                    "TUN 内核已启动，但混合端口 {mixed_port} 没有监听。{}",
                    log_tail(&log_path)
                ));
            }
            return Ok(st);
        }
        #[cfg(not(target_os = "windows"))]
        {
        // 非 setuid 内核的 TUN：借 osascript 提权启动，会弹一次系统密码框
        let script = format!(
            "do shell script \"'{}' -d '{}' -f '{}' > '{}' 2>&1 &\" with administrator privileges",
            binary.display(),
            data.display(),
            config.display(),
            log_path.display()
        );
        let status = crate::platform::async_command("osascript")
            .arg("-e")
            .arg(&script)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .map_err(|e| format!("提权启动失败：{e}"))?;

        if !status.success() {
            return Err("提权被取消：TUN 需要管理员权限".to_string());
        }

        let mut st = wait_ready(controller_port, None, &log_path, "TUN 内核").await?;
        st.reclaimed = reclaimed.clone();
        tokio::time::sleep(Duration::from_millis(300)).await;
        if !tcp_port_open(mixed_port) {
            return Err(format!(
                "TUN 内核已启动，但混合端口 {mixed_port} 没有监听。{}",
                log_tail(&log_path)
            ));
        }
        return Ok(st);
        }
    }

    let mut child = crate::platform::async_command(&binary)
        .arg("-d")
        .arg(&data)
        .arg("-f")
        .arg(&config)
        .current_dir(&data)
        .stdout(Stdio::from(
            log_file
                .try_clone()
                .map_err(|e| format!("打开内核日志失败：{e}"))?,
        ))
        .stderr(Stdio::from(log_file))
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("启动内核失败：{e}"))?;

    match wait_ready(controller_port, Some(&mut child), &log_path, "内核").await {
        Ok(mut st) => {
            st.reclaimed = reclaimed.clone();
            tokio::time::sleep(Duration::from_millis(300)).await;
            if !tcp_port_open(mixed_port) {
                let _ = child.kill().await;
                return Err(format!(
                    "内核已启动，但混合端口 {mixed_port} 没有监听，已自动停止（否则系统代理会指向死端口）。{}",
                    log_tail(&log_path)
                ));
            }
            if privileged {
                if let Some(line) = tun_error_line(&log_path) {
                    let _ = child.kill().await;
                    return Err(format!("TUN 创建失败（{line}），已停止内核"));
                }
            }
            let state = app.state::<KernelState>();
            *state.child.lock().await = Some(child);
            Ok(st)
        }
        Err(e) => {
            let _ = child.kill().await;
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn stop_kernel(app: tauri::AppHandle) -> Result<KernelStatus, String> {
    let state = app.state::<KernelState>();
    let privileged = *state.privileged.lock().await;
    let config_path = state.config_path.lock().await.clone();
    let had_child = state.child.lock().await.is_some();

    if let Some(mut child) = state.child.lock().await.take() {
        let _ = child.kill().await;
        // setuid 内核偶尔会忽略/延迟处理信号，不能无限等，否则 UI 永远卡在「正在停止」
        let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
    }

    if privileged {
        #[cfg(target_os = "windows")]
        if let Some(cfg) = &config_path {
            if let Some(pid) = pid_of_process(cfg) {
                terminate_elevated(pid);
            }
        }
        #[cfg(not(target_os = "windows"))]
        if let Some(cfg) = &config_path {
            // osascript 提权启动的进程普通用户杀不掉，同样借管理员权限
            let script = format!(
                "do shell script \"pkill -f '{}'\" with administrator privileges",
                cfg
            );
            let _ = crate::platform::async_command("osascript")
                .arg("-e")
                .arg(&script)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await;
        }
        *state.privileged.lock().await = false;
    } else if let Some(cfg) = &config_path {
        #[cfg(target_os = "windows")]
        if let Some(pid) = pid_of_process(cfg) {
            terminate(pid);
        }
        #[cfg(not(target_os = "windows"))]
        {
        // 兜底：按配置路径清理孤儿进程（setuid 内核 real uid 仍是当前用户，可杀）
        let _ = crate::platform::command("pkill")
            .arg("-f")
            .arg(cfg)
            .status();
        }
    }

    // 等端口真正释放再返回：否则紧接着的 restart 会撞上「仍被占用」
    if let Some(cfg) = state.config_path.lock().await.clone() {
        let (mixed, controller, _, _) = config_ports(Path::new(&cfg));
        for _ in 0..80 {
            if tcp_port_free(mixed) && tcp_port_free(controller) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    // 端口还活着说明进程没有真正退出；不要向上层谎报 stopped，
    // 更不要让前端在 TUN 仍生效时把开关画成关闭。
    if (had_child || privileged) && tcp_port_open(*state.controller_port.lock().await) {
        return Err("内核仍在运行，停止未完成".to_string());
    }

    Ok(KernelStatus {
        running: false,
        pid: None,
        reclaimed: Vec::new(),
    })
}

/// 清理数据目录对应的残留内核进程（应用上次崩溃 / 强退时可能留下 TUN 内核）。
#[tauri::command]
pub async fn cleanup_stale_kernel() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if let Some(pid) = pid_of_process("PPClash\\config.yaml") {
            terminate(pid);
        }
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = crate::platform::async_command("pkill")
            .arg("-f")
            .arg("Application Support/PPClash/config.yaml")
            .status()
            .await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command as StdCommand, Stdio};

    #[test]
    fn reclaim_kills_user_listener() {
        let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);

        let script = format!(
            "import socket,time\ns=socket.socket()\ns.bind(('127.0.0.1',{port}))\ns.listen()\ntime.sleep(30)"
        );
        let mut child = StdCommand::new("python3")
            .args(["-c", &script])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn python listener");

        for _ in 0..60 {
            if !tcp_port_free(port) {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!tcp_port_free(port), "dummy listener should occupy port");

        let killed = reclaim_ports(&[(port, true)]);
        let _ = child.kill();
        let _ = child.wait();

        assert!(ports_free(&[(port, true)]), "port should be freed");
        assert!(!killed.is_empty(), "should report killed pid");
    }
}

/// 用内置内核 `-t` 校验配置文件。返回 Ok 表示能被内核接受。
#[tauri::command]
pub async fn validate_config(
    app: tauri::AppHandle,
    config_path: String,
    data_dir: String,
) -> Result<(), String> {
    let config = std::path::PathBuf::from(&config_path);
    if !config.is_file() {
        return Err(format!("配置文件不存在：{config_path}"));
    }
    let (bin, _) = resources::ensure_kernel(&app)?;
    let out = tokio::task::spawn_blocking(move || {
        crate::platform::command(&bin)
            .args(["-t", "-d", &data_dir, "-f", &config_path])
            .output()
    })
    .await
    .map_err(|e| format!("校验任务失败：{e}"))?
    .map_err(|e| format!("执行内核校验失败：{e}"))?;

    if out.status.success() {
        return Ok(());
    }
    let mut text = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if text.is_empty() {
        text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    }
    let tail: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).rev().take(3).collect();
    let mut tail = tail;
    tail.reverse();
    Err(if tail.is_empty() {
        "配置校验失败".to_string()
    } else {
        tail.join(" | ")
    })
}
