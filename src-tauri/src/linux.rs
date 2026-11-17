//! GNOME / KDE 代理与 Linux 内核的网络能力授权。命令使用独立参数，不拼接 shell。
use crate::sysproxy::SysProxyState;

trait Runner {
    fn run(&self, program: &str, args: &[&str]) -> Result<String, String>;
}

#[derive(Clone, Copy)]
enum Backend {
    Gnome,
    Kde(u8),
}

fn detect(runner: &impl Runner, desktop: &str) -> Result<Backend, String> {
    let desktop = desktop.to_ascii_lowercase();
    if desktop.contains("kde") {
        for version in [6, 5] {
            if runner
                .run(
                    &format!("kreadconfig{version}"),
                    &[
                        "--file",
                        "kioslaverc",
                        "--group",
                        "Proxy Settings",
                        "--key",
                        "ProxyType",
                        "--default",
                        "0",
                    ],
                )
                .is_ok()
            {
                return Ok(Backend::Kde(version));
            }
        }
    } else if ["gnome", "unity", "cinnamon", "budgie"]
        .iter()
        .any(|name| desktop.contains(name))
    {
        if runner
            .run("gsettings", &["list-schemas"])?
            .lines()
            .any(|s| s == "org.gnome.system.proxy")
        {
            return Ok(Backend::Gnome);
        }
    }
    Err("此桌面环境未提供可用的系统代理接口；支持 GNOME / KDE，可使用 TUN 或手动配置代理".into())
}

fn gget(runner: &impl Runner, schema: &str, key: &str) -> Result<String, String> {
    runner
        .run("gsettings", &["get", schema, key])
        .map(|s| s.trim().to_string())
}

fn kget(runner: &impl Runner, version: u8, key: &str) -> Result<String, String> {
    runner
        .run(
            &format!("kreadconfig{version}"),
            &[
                "--file",
                "kioslaverc",
                "--group",
                "Proxy Settings",
                "--key",
                key,
            ],
        )
        .map(|s| s.trim().to_string())
}

fn get_with(runner: &impl Runner, backend: Backend) -> Result<SysProxyState, String> {
    match backend {
        Backend::Gnome => Ok(SysProxyState {
            enabled: gget(runner, "org.gnome.system.proxy", "mode")? == "'manual'",
            host: gget(runner, "org.gnome.system.proxy.http", "host")?
                .trim_matches('\'')
                .to_string(),
            port: gget(runner, "org.gnome.system.proxy.http", "port")?
                .parse()
                .map_err(|_| "系统代理端口格式无效".to_string())?,
        }),
        Backend::Kde(version) => {
            let proxy = kget(runner, version, "httpProxy")?;
            let parsed = reqwest::Url::parse(&proxy).ok();
            Ok(SysProxyState {
                enabled: kget(runner, version, "ProxyType")? == "1",
                host: parsed
                    .as_ref()
                    .and_then(|u| u.host_str())
                    .unwrap_or("")
                    .to_string(),
                port: parsed.and_then(|u| u.port_or_known_default()).unwrap_or(0),
            })
        }
    }
}

fn set_with(
    runner: &impl Runner,
    backend: Backend,
    enable: bool,
    host: &str,
    port: u16,
) -> Result<SysProxyState, String> {
    if port == 0 || host.parse::<std::net::IpAddr>().is_err() {
        return Err("系统代理需要有效的 IP 地址和端口".into());
    }
    let current = get_with(runner, backend)?;
    // 代理已被其他应用接管时保留；HTTPS 也必须仍属于本应用。
    if !enable && (!current.enabled || current.host != host || current.port != port) {
        return Ok(current);
    }
    let bracket_host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    let endpoint = format!("http://{bracket_host}:{port}");
    match backend {
        Backend::Gnome => {
            if !enable
                && (gget(runner, "org.gnome.system.proxy.https", "host")? != format!("'{host}'")
                    || gget(runner, "org.gnome.system.proxy.https", "port")? != port.to_string())
            {
                return Ok(current);
            }
            let mut changes = vec![];
            if enable {
                changes.extend([
                    ("org.gnome.system.proxy.http", "host", format!("'{host}'")),
                    ("org.gnome.system.proxy.http", "port", port.to_string()),
                    ("org.gnome.system.proxy.https", "host", format!("'{host}'")),
                    ("org.gnome.system.proxy.https", "port", port.to_string()),
                    ("org.gnome.system.proxy", "use-same-proxy", "false".into()),
                ]);
            }
            changes.push((
                "org.gnome.system.proxy",
                "mode",
                if enable { "'manual'" } else { "'none'" }.into(),
            ));
            let original: Vec<_> = changes
                .iter()
                .map(|(schema, key, _)| gget(runner, schema, key))
                .collect::<Result<_, _>>()?;
            for (index, (schema, key, value)) in changes.iter().enumerate() {
                let result = runner
                    .run("gsettings", &["set", schema, key, value])
                    .and_then(|_| {
                        if gget(runner, schema, key)? == *value {
                            Ok(())
                        } else {
                            Err("桌面代理配置未生效".into())
                        }
                    });
                if let Err(error) = result {
                    let mut rollback_failed = false;
                    for (j, (schema, key, _)) in changes[..=index].iter().enumerate().rev() {
                        rollback_failed |= runner
                            .run("gsettings", &["set", schema, key, &original[j]])
                            .is_err();
                    }
                    return Err(format!(
                        "{error}{}",
                        if rollback_failed {
                            "；回滚失败，请检查桌面代理设置"
                        } else {
                            "；已恢复原代理配置"
                        }
                    ));
                }
            }
        }
        Backend::Kde(version) => {
            if !enable && kget(runner, version, "httpsProxy")? != endpoint {
                return Ok(current);
            }
            let mut changes = vec![];
            if enable {
                changes.extend([("httpProxy", endpoint.clone()), ("httpsProxy", endpoint)]);
            }
            changes.push(("ProxyType", if enable { "1" } else { "0" }.into()));
            let original: Vec<_> = changes
                .iter()
                .map(|(key, _)| kget(runner, version, key))
                .collect::<Result<_, _>>()?;
            let program = format!("kwriteconfig{version}");
            let write = |key: &str, value: &str| {
                runner.run(
                    &program,
                    &[
                        "--file",
                        "kioslaverc",
                        "--group",
                        "Proxy Settings",
                        "--key",
                        key,
                        value,
                    ],
                )
            };
            let apply = (|| {
                for (key, value) in &changes {
                    write(key, value)?;
                    if kget(runner, version, key)? != *value {
                        return Err("KDE 代理配置未生效".into());
                    }
                }
                runner.run(
                    "dbus-send",
                    &[
                        "--session",
                        "--type=signal",
                        "/KIO/Scheduler",
                        "org.kde.KIO.Scheduler.reparseSlaveConfiguration",
                        "string:",
                    ],
                )?;
                Ok::<_, String>(())
            })();
            if let Err(error) = apply {
                let mut failed = false;
                for ((key, _), value) in changes.iter().zip(&original).rev() {
                    failed |= write(key, value).is_err();
                }
                return Err(format!(
                    "{error}{}",
                    if failed {
                        "；回滚失败，请检查 KDE 代理设置"
                    } else {
                        "；已恢复原代理配置"
                    }
                ));
            }
        }
    }
    get_with(runner, backend)
}

fn has_network_caps(output: &str) -> bool {
    // 不从文件名匹配能力名称；getcap 把能力字段输出在行尾。
    let capabilities = output.split_whitespace().last().unwrap_or("");
    let Some((names, flags)) = capabilities.split_once('=') else {
        return false;
    };
    flags.contains('e')
        && flags.contains('p')
        && ["cap_net_admin", "cap_net_raw", "cap_net_bind_service"]
            .iter()
            .all(|name| names.split(',').any(|value| value == *name))
}

#[cfg(target_os = "linux")]
struct System;
#[cfg(target_os = "linux")]
impl Runner for System {
    fn run(&self, program: &str, args: &[&str]) -> Result<String, String> {
        let result = crate::platform::command(program)
            .args(args)
            .output()
            .map_err(|e| format!("无法调用 {program}：{e}"))?;
        if !result.status.success() {
            return Err(format!(
                "{program} 执行失败：{}",
                String::from_utf8_lossy(&result.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&result.stdout).trim().to_string())
    }
}

#[cfg(target_os = "linux")]
fn desktop_backend() -> Result<Backend, String> {
    detect(
        &System,
        &std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default(),
    )
}
#[cfg(target_os = "linux")]
pub fn get_proxy() -> Result<SysProxyState, String> {
    get_with(&System, desktop_backend()?)
}
#[cfg(target_os = "linux")]
pub fn set_proxy(enable: bool, host: &str, port: u16) -> Result<SysProxyState, String> {
    set_with(&System, desktop_backend()?, enable, host, port)
}

#[cfg(target_os = "linux")]
fn capability_tool(name: &str) -> Result<std::path::PathBuf, String> {
    ["/usr/sbin", "/sbin", "/usr/bin"]
        .iter()
        .map(|dir| std::path::Path::new(dir).join(name))
        .find(|p| p.is_file())
        .ok_or_else(|| "请先安装 libcap 工具（Debian/Ubuntu：libcap2-bin；Fedora：libcap）".into())
}
#[cfg(target_os = "linux")]
pub fn network_authorized(path: &std::path::Path) -> bool {
    let Ok(tool) = capability_tool("getcap") else {
        return false;
    };
    System
        .run(&tool.to_string_lossy(), &[&path.to_string_lossy()])
        .is_ok_and(|s| has_network_caps(&s))
}
#[cfg(unix)]
fn restrict_kernel_execution(path: &std::path::Path, uid: u32) -> Result<(), String> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let metadata = std::fs::metadata(path).map_err(|e| format!("无法读取内核权限：{e}"))?;
    if !metadata.is_file() || metadata.uid() != uid {
        return Err("只能授权当前用户拥有的内核文件，请先复制到应用数据目录".into());
    }
    // 先限制为仅属主可执行，再授予网络能力，避免其他本地用户借用内核。
    if metadata.mode() & 0o7777 != 0o700 {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("无法限制内核执行权限：{e}"))?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn authorize_kernel(
    path: &std::path::Path,
    remove: bool,
) -> Result<std::path::PathBuf, String> {
    let path = std::fs::canonicalize(path).map_err(|e| format!("内核路径无效：{e}"))?;
    let uid = System
        .run("/usr/bin/id", &["-u"])?
        .parse::<u32>()
        .map_err(|_| "无法读取当前用户身份".to_string())?;
    restrict_kernel_execution(&path, uid)?;
    if !remove && network_authorized(&path) {
        return Ok(path);
    }
    let tool = capability_tool("setcap")?;
    let capability = if remove {
        "-r"
    } else {
        "cap_net_admin,cap_net_raw,cap_net_bind_service=+ep"
    };
    // polkit 只授权 setcap；内核保持用户身份，正常退出与崩溃清理不需要再次提权。
    System.run(
        "/usr/bin/pkexec",
        &[&tool.to_string_lossy(), capability, &path.to_string_lossy()],
    )?;
    if network_authorized(&path) == remove {
        return Err("内核网络授权未生效，请检查文件系统是否支持扩展属性及 polkit 授权".into());
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    struct Fake {
        values: RefCell<BTreeMap<String, String>>,
        calls: RefCell<Vec<Vec<String>>>,
        fail_key: Option<&'static str>,
    }
    impl Fake {
        fn gnome() -> Self {
            Self {
                values: RefCell::new(
                    [
                        ("org.gnome.system.proxy mode", "'none'"),
                        ("org.gnome.system.proxy use-same-proxy", "false"),
                        ("org.gnome.system.proxy.http host", "'old'"),
                        ("org.gnome.system.proxy.http port", "1234"),
                        ("org.gnome.system.proxy.https host", "'old'"),
                        ("org.gnome.system.proxy.https port", "1234"),
                    ]
                    .into_iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
                ),
                calls: RefCell::new(vec![]),
                fail_key: None,
            }
        }
    }
    impl Runner for Fake {
        fn run(&self, program: &str, args: &[&str]) -> Result<String, String> {
            self.calls.borrow_mut().push(
                std::iter::once(program.to_string())
                    .chain(args.iter().map(|s| s.to_string()))
                    .collect(),
            );
            if program != "gsettings" {
                return Err("not installed".into());
            }
            if args == ["list-schemas"] {
                return Ok("org.gnome.system.proxy\n".into());
            }
            let key = format!("{} {}", args[1], args[2]);
            if args[0] == "get" {
                return self
                    .values
                    .borrow()
                    .get(&key)
                    .cloned()
                    .ok_or("missing".into());
            }
            if self.fail_key == Some(key.as_str()) && args[3] == "7890" {
                return Err("read-only".into());
            }
            self.values.borrow_mut().insert(key, args[3].to_string());
            Ok(String::new())
        }
    }

    #[test]
    fn gnome_enables_then_disables_only_its_own_proxy() {
        let r = Fake::gnome();
        let backend = detect(&r, "GNOME").unwrap();
        assert!(!get_with(&r, backend).unwrap().enabled);
        assert!(
            set_with(&r, backend, true, "127.0.0.1", 7890)
                .unwrap()
                .enabled
        );
        let before = r.values.borrow().clone();
        set_with(&r, backend, false, "127.0.0.1", 9999).unwrap();
        assert_eq!(*r.values.borrow(), before, "不能关闭其他应用的端口");
        assert!(
            !set_with(&r, backend, false, "127.0.0.1", 7890)
                .unwrap()
                .enabled
        );
    }

    #[test]
    fn failed_write_rolls_back_and_foreign_https_is_preserved() {
        let mut r = Fake::gnome();
        r.fail_key = Some("org.gnome.system.proxy.https port");
        let backend = detect(&r, "GNOME").unwrap();
        let original = r.values.borrow().clone();
        assert!(set_with(&r, backend, true, "127.0.0.1", 7890).is_err());
        assert_eq!(*r.values.borrow(), original);
        r.fail_key = None;
        set_with(&r, backend, true, "127.0.0.1", 7890).unwrap();
        r.values.borrow_mut().insert(
            "org.gnome.system.proxy.https host".into(),
            "'other-app'".into(),
        );
        let original = r.values.borrow().clone();
        set_with(&r, backend, false, "127.0.0.1", 7890).unwrap();
        assert_eq!(*r.values.borrow(), original);
    }

    #[test]
    fn unsupported_desktop_is_explicit_and_caps_require_all_network_permissions() {
        assert!(detect(&Fake::gnome(), "sway").is_err());
        assert!(has_network_caps(
            "/tmp/mihomo cap_net_bind_service,cap_net_admin,cap_net_raw=ep"
        ));
        assert!(!has_network_caps("/tmp/cap_net_admin cap_net_raw=ep"));
        assert!(!has_network_caps(
            "/tmp/mihomo cap_net_bind_service,cap_net_admin,cap_net_raw=p"
        ));
    }

    #[cfg(unix)]
    #[test]
    fn network_binary_is_owner_only_and_foreign_files_are_rejected() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("内核 with spaces");
        std::fs::write(&path, b"fixture").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let uid = std::fs::metadata(&path).unwrap().uid();
        assert!(restrict_kernel_execution(&path, uid.wrapping_add(1)).is_err());
        assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o7777, 0o755);
        restrict_kernel_execution(&path, uid).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o7777, 0o700);
        restrict_kernel_execution(&path, uid).unwrap();
        assert!(restrict_kernel_execution(root.path(), uid).is_err());
    }

    struct KdeFake {
        version: u8,
        values: RefCell<BTreeMap<String, String>>,
        notify_fails: bool,
    }
    impl Runner for KdeFake {
        fn run(&self, program: &str, args: &[&str]) -> Result<String, String> {
            if program == "dbus-send" {
                return if self.notify_fails {
                    Err("DBus unavailable".into())
                } else {
                    Ok(String::new())
                };
            }
            if program != format!("kreadconfig{}", self.version)
                && program != format!("kwriteconfig{}", self.version)
            {
                return Err("not installed".into());
            }
            let key = args[args.iter().position(|v| *v == "--key").unwrap() + 1];
            if program.starts_with("kread") {
                return Ok(self.values.borrow().get(key).cloned().unwrap_or_default());
            }
            self.values
                .borrow_mut()
                .insert(key.into(), args.last().unwrap().to_string());
            Ok(String::new())
        }
    }

    #[test]
    fn kde5_and_kde6_preserve_foreign_proxy_and_rollback_on_notification_failure() {
        for version in [5, 6] {
            let mut r = KdeFake {
                version,
                values: RefCell::new([("ProxyType".into(), "0".into())].into()),
                notify_fails: false,
            };
            let backend = detect(&r, "KDE").unwrap();
            let enabled = set_with(&r, backend, true, "127.0.0.1", 7890).unwrap();
            assert!(enabled.enabled);
            assert_eq!(enabled.port, 7890);
            let original = r.values.borrow().clone();
            set_with(&r, backend, false, "127.0.0.1", 9999).unwrap();
            assert_eq!(*r.values.borrow(), original);
            assert!(
                !set_with(&r, backend, false, "127.0.0.1", 7890)
                    .unwrap()
                    .enabled
            );
            let original = r.values.borrow().clone();
            r.notify_fails = true;
            assert!(set_with(&r, backend, true, "127.0.0.1", 8888).is_err());
            assert_eq!(*r.values.borrow(), original);
        }
    }
}
